/* AGPL-3.0-or-later */
// In-sandbox agent runner. Receives a per-run job over POST /run (objective,
// repo, ephemeral tokens, AI Gateway config), clones the repo, runs the coding
// agent (claude-code / codex) routed through the AI Gateway, runs the project's
// test suite (test gate), and opens a PR — a draft if tests fail. Secrets arrive
// only in the request body and are passed to the agent subprocess as env vars,
// never baked into the image. See SANDBOX_REVIEW.md §4.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
// 250 turns can run long; keep the cap generous so the agent is never SIGKILLed
// mid-task. Floor is 90 minutes.
const AGENT_TIMEOUT_MS = 90 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function tail(text, n = 3000) {
  return (text || "").slice(-n);
}

// One structured line per stage so `wrangler tail` / container logs show exactly
// where a run is and how long each stage took.
function step(runId, stage, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), runId, stage, ...extra }));
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

// Build the agent subprocess env. claude-code uses a long-lived OAuth token
// (`claude setup-token`) that bills against the user's Pro/Max subscription —
// gateway routing does not apply to OAuth/subscription auth. codex (OpenAI-
// compatible) still routes through Cloudflare AI Gateway when available.
function buildAgentEnv(job) {
  const env = { HOME: "/tmp", IS_SANDBOX: "1" };
  if (job.linearToken) env.LINEAR_API_KEY = job.linearToken;

  if (job.agentProvider === "codex") {
    const gw = job.aiGateway;
    if (gw?.url) {
      env.OPENAI_BASE_URL = gw.url;
    }
    return env;
  }

  // claude-code: subscription/OAuth auth, calls hit api.anthropic.com directly.
  if (job.claudeOauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = job.claudeOauthToken;
  }
  return env;
}

function agentCommand(job) {
  if (job.agentProvider === "codex") {
    return { cmd: "codex", args: ["exec", "--full-auto", job.objective] };
  }
  return {
    cmd: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--max-turns", "250", job.objective],
  };
}

// Detect how to install + test the project. Returns null for unknown types, and
// test:null when a recognized type has no usable test harness.
function detectTestPlan(repoDir) {
  if (existsSync(path.join(repoDir, "package.json"))) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf8")).scripts ?? {};
    } catch {
      scripts = {};
    }
    if (!scripts.test) {
      return { projectType: "nodejs", install: null, test: null, reason: "no test script in package.json" };
    }
    return {
      projectType: "nodejs",
      install: ["npm", ["install", "--no-audit", "--no-fund"]],
      test: ["npm", ["test"]],
    };
  }
  if (existsSync(path.join(repoDir, "go.mod"))) {
    return { projectType: "go", install: ["go", ["mod", "download"]], test: ["go", ["test", "./..."]] };
  }
  if (existsSync(path.join(repoDir, "requirements.txt"))) {
    return {
      projectType: "python",
      install: ["python3", ["-m", "pip", "install", "--user", "--break-system-packages", "-r", "requirements.txt"]],
      test: ["python3", ["-m", "pytest"]],
    };
  }
  if (existsSync(path.join(repoDir, "pyproject.toml"))) {
    return {
      projectType: "python",
      install: ["python3", ["-m", "pip", "install", "--user", "--break-system-packages", "-e", "."]],
      test: ["python3", ["-m", "pytest"]],
    };
  }
  if (existsSync(path.join(repoDir, "Cargo.toml"))) {
    return { projectType: "rust", install: ["cargo", ["fetch"]], test: ["cargo", ["test"]] };
  }
  return null;
}

function toolMissing(result) {
  return result.code === -1 && /ENOENT|not found/i.test(result.stderr);
}

// Run install + tests against the (already-committed) working tree. Never throws;
// returns a structured verdict. ran=false means "couldn't/needn't run" (no harness
// or toolchain) and is treated as non-blocking.
async function runTestGate(repoDir) {
  const plan = detectTestPlan(repoDir);
  if (!plan) {
    return { ran: false, projectType: "unknown", summary: "No recognized project type; tests skipped." };
  }
  if (!plan.test) {
    return { ran: false, projectType: plan.projectType, summary: `Tests skipped: ${plan.reason}.` };
  }

  if (plan.install) {
    const install = await exec(plan.install[0], plan.install[1], { cwd: repoDir, timeoutMs: INSTALL_TIMEOUT_MS });
    if (toolMissing(install)) {
      return {
        ran: false,
        projectType: plan.projectType,
        summary: `Tests skipped: "${plan.install[0]}" not available in sandbox.`,
      };
    }
    if (install.code !== 0) {
      return {
        ran: true,
        passed: false,
        exitCode: install.code,
        projectType: plan.projectType,
        summary: `Dependency install failed (exit ${install.code}).\n${tail(install.stderr || install.stdout)}`,
      };
    }
  }

  const test = await exec(plan.test[0], plan.test[1], { cwd: repoDir, timeoutMs: TEST_TIMEOUT_MS });
  if (toolMissing(test)) {
    return {
      ran: false,
      projectType: plan.projectType,
      summary: `Tests skipped: "${plan.test[0]}" not available in sandbox.`,
    };
  }
  return {
    ran: true,
    passed: test.code === 0,
    exitCode: test.code,
    projectType: plan.projectType,
    summary: tail(`${test.stdout || ""}${test.stderr ? `\n${test.stderr}` : ""}`),
  };
}

function testStatusLine(gate) {
  if (!gate.ran) return `⚠️ ${gate.summary}`;
  return gate.passed
    ? `✅ Tests passed (${gate.projectType})`
    : `❌ Tests failed (${gate.projectType}, exit ${gate.exitCode})`;
}

async function openPullRequest(job, head, base, title, body, draft) {
  const res = await fetch(`https://api.github.com/repos/${job.repo.owner}/${job.repo.repo}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${job.githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "fly-dev",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ title, head, base, body, draft }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: (await res.text()).slice(0, 500) };
  }
  const json = await res.json();
  return { ok: true, prUrl: json.html_url, prNumber: json.number };
}

async function handleRun(rawBody) {
  let job;
  try {
    job = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!job.runId || !job.objective || !job.repo?.owner || !job.repo?.repo || !job.githubToken) {
    return { ok: false, error: "missing_required_fields" };
  }

  const baseBranch = job.repo.baseBranch || "main";
  const branch = `fly-dev/${job.runId}`;
  const workdir = await mkdtemp(path.join(tmpdir(), `fly-${job.runId}-`));
  const repoDir = path.join(workdir, job.repo.repo);
  // Candidate tokens to try, in order: the (least-privilege) primary, then the
  // OAuth fallback. The App installation token can 403 on private repos it isn't
  // installed on; the user's OAuth token has full `repo` access. We pick whichever
  // authenticates the clone and reuse it for the push.
  const tokens = [job.githubToken, job.githubFallbackToken].filter(Boolean);
  const repoPath = `github.com/${job.repo.owner}/${job.repo.repo}.git`;
  const cloneUrlFor = (tok) => `https://x-access-token:${tok}@${repoPath}`;

  try {
    step(job.runId, "clone:start", { repo: `${job.repo.owner}/${job.repo.repo}`, baseBranch, tokenCandidates: tokens.length });
    let clone = { code: -1, stderr: "no token" };
    let activeToken = null;
    for (const tok of tokens) {
      clone = await exec(
        "git",
        ["clone", "--depth=1", "--branch", baseBranch, cloneUrlFor(tok), repoDir],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (clone.code === 0) { activeToken = tok; break; }
      step(job.runId, "clone:retry", { code: clone.code, authError: /403|401|not granted|Authentication/i.test(clone.stderr) });
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
    if (clone.code !== 0 || !activeToken) {
      step(job.runId, "clone:failed", { code: clone.code });
      return { ok: false, error: "clone_failed", logs: clone.stderr.slice(-4000) };
    }
    step(job.runId, "clone:done");
    const pushUrl = cloneUrlFor(activeToken);

    await exec("git", ["checkout", "-b", branch], { cwd: repoDir });
    await exec("git", ["config", "user.email", "fly-dev[bot]@users.noreply.github.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "fly-dev[bot]"], { cwd: repoDir });

    const { cmd, args } = agentCommand(job);
    step(job.runId, "agent:start", { provider: job.agentProvider ?? "claude-code", cmd });
    const agentStartedAt = Date.now();
    const agent = await exec(cmd, args, {
      cwd: repoDir,
      env: buildAgentEnv(job),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    step(job.runId, "agent:done", { exitCode: agent.code, ms: Date.now() - agentStartedAt });
    const summary = (agent.stdout || "").slice(-4000);
    const logs = (agent.stderr || "").slice(-4000);

    const status = await exec("git", ["status", "--porcelain"], { cwd: repoDir });
    if (!status.stdout.trim()) {
      step(job.runId, "no_changes");
      return { ok: false, error: "no_changes", summary, logs };
    }
    step(job.runId, "changes:detected");

    // Commit the agent's changes BEFORE install/test so install artifacts
    // (e.g. node_modules) are never added to the commit.
    await exec("git", ["add", "-A"], { cwd: repoDir });
    const title = `feat: ${job.objective}`.slice(0, 72);
    const commit = await exec(
      "git",
      ["commit", "-m", `${title}\n\n[fly-dev run ${job.runId}]`],
      { cwd: repoDir },
    );
    if (commit.code !== 0) {
      return { ok: false, error: "commit_failed", logs: commit.stderr.slice(-2000), summary };
    }

    // Test gate: install deps + run the suite. A failing suite does not block the
    // PR — it opens it as a draft so a human reviews. See SANDBOX_REVIEW.md test gate.
    step(job.runId, "test:start");
    const gate = await runTestGate(repoDir);
    const draft = gate.ran === true && gate.passed === false;
    step(job.runId, "test:done", { ran: gate.ran, passed: gate.passed ?? null, projectType: gate.projectType });

    step(job.runId, "push:start", { branch });
    const push = await exec("git", ["push", pushUrl, branch], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    if (push.code !== 0) {
      step(job.runId, "push:failed", { code: push.code });
      return { ok: false, error: "push_failed", logs: push.stderr.slice(-2000), summary };
    }
    step(job.runId, "push:done");

    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const commitSha = head.stdout.trim();
    const diff = (
      await exec("git", ["diff", `${baseBranch}...${branch}`], { cwd: repoDir, timeoutMs: 30_000 })
    ).stdout.slice(0, 50_000);

    const prBody =
      `## Summary\n\n${summary || "_(no summary)_"}\n\n` +
      `## Tests\n\n${testStatusLine(gate)}\n\n` +
      (gate.ran ? `\`\`\`\n${tail(gate.summary, 1500)}\n\`\`\`\n\n` : "") +
      `---\n_Opened automatically by fly-dev run ${job.runId}._`;

    step(job.runId, "pr:start", { draft });
    const pr = await openPullRequest(job, branch, baseBranch, title, prBody, draft);
    step(job.runId, "pr:done", { ok: pr.ok, prNumber: pr.prNumber ?? null, status: pr.status ?? null });
    if (!pr.ok) {
      return {
        ok: false,
        error: "pr_failed",
        branch,
        commitSha,
        diff,
        summary,
        logs: `PR create HTTP ${pr.status}: ${pr.text}`,
        testsRun: gate.ran,
        testsPassed: gate.passed ?? null,
        testExitCode: gate.exitCode ?? null,
        projectType: gate.projectType,
        testSummary: tail(gate.summary, 2000),
      };
    }

    return {
      ok: true,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      prDraft: draft,
      branch,
      commitSha,
      diff,
      summary,
      logs,
      testsRun: gate.ran,
      testsPassed: gate.passed ?? null,
      testExitCode: gate.exitCode ?? null,
      projectType: gate.projectType,
      testSummary: tail(gate.summary, 2000),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/ready") {
    return sendJson(response, 200, { ok: true, runtime: "fly-dev-sandbox" });
  }
  if (request.method === "POST" && request.url === "/run") {
    try {
      const body = await readBody(request);
      const result = await handleRun(body);
      return sendJson(response, 200, result);
    } catch (err) {
      return sendJson(response, 200, { ok: false, error: "exception", message: String(err) });
    }
  }
  return sendJson(response, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0");
