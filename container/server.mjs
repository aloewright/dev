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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
// 250 turns can run long; keep the cap generous so the agent is never SIGKILLed
// mid-task. Floor is 90 minutes.
const AGENT_TIMEOUT_MS = 90 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
// How many times the agent may re-attempt to make a failing suite pass.
const MAX_FIX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // Detach stdin (→ /dev/null) so CLIs like `claude` don't block 3s waiting for
      // piped input; the prompt is passed as an argument, not via stdin.
      stdio: ["ignore", "pipe", "pipe"],
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

function agentCommand(job, prompt) {
  if (job.agentProvider === "codex") {
    return { cmd: "codex", args: ["exec", "--full-auto", prompt] };
  }
  return {
    cmd: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-6", "--effort", "medium", "--max-turns", "250", prompt],
  };
}

// Run the coding agent with an arbitrary prompt against the working tree.
async function runAgent(job, repoDir, prompt) {
  const { cmd, args } = agentCommand(job, prompt);
  return exec(cmd, args, { cwd: repoDir, env: buildAgentEnv(job), timeoutMs: AGENT_TIMEOUT_MS });
}

// Stage + commit everything (no-op-safe: returns false when there was nothing to
// commit). Used after each agent pass.
async function commitAll(repoDir, message) {
  await exec("git", ["add", "-A"], { cwd: repoDir });
  const res = await exec("git", ["commit", "-m", message], { cwd: repoDir });
  return res.code === 0;
}

// Guard against committing dependency/build artifacts created by the test gate
// (the agent fix loop runs `git add -A` AFTER install). Local-only, never pushed.
function writeGitExclude(repoDir) {
  try {
    appendFileSync(
      path.join(repoDir, ".git", "info", "exclude"),
      "\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n*.pyc\n.pytest_cache/\n.mypy_cache/\n.tox/\n*.egg-info/\ntarget/\n.cache/\n.gradle/\ncoverage/\n.next/\n.nuxt/\n",
    );
  } catch {
    /* best-effort */
  }
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

async function openPullRequest(job, head, base, title, body, draft, token) {
  const res = await fetch(`https://api.github.com/repos/${job.repo.owner}/${job.repo.repo}/pulls`, {
    method: "POST",
    headers: {
      // Use the token that actually authenticated clone/push — the App token may
      // 403 on repos it can't reach, while the OAuth fallback works.
      authorization: `Bearer ${token || job.githubToken}`,
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

// Run the test gate; if it fails, have the agent fix it and re-test, up to
// MAX_FIX_ATTEMPTS. Commits each fix attempt. Returns the final gate verdict.
async function ensureTestsPass(job, repoDir) {
  let gate = await runTestGate(repoDir);
  step(job.runId, "test:done", { ran: gate.ran, passed: gate.passed ?? null, projectType: gate.projectType });
  let attempt = 0;
  while (gate.ran === true && gate.passed === false && attempt < MAX_FIX_ATTEMPTS) {
    attempt += 1;
    step(job.runId, "test:fix", { attempt });
    const prompt =
      `The project's test suite is FAILING. Make the failing tests pass by fixing the ` +
      `implementation (and the tests themselves only where they are genuinely wrong). ` +
      `Do NOT delete, skip, or weaken tests just to make them pass. Then stop.\n\n` +
      `Test output:\n${tail(gate.summary, 5000)}`;
    await runAgent(job, repoDir, prompt);
    await commitAll(repoDir, `fix: make tests pass (attempt ${attempt}) [fly-dev run ${job.runId}]`);
    gate = await runTestGate(repoDir);
    step(job.runId, "test:retry", { attempt, passed: gate.passed ?? null });
  }
  return gate;
}

// GitHub REST helper scoped to the job's repo.
function ghApi(job, token, suffix, init = {}) {
  return fetch(`https://api.github.com/repos/${job.repo.owner}/${job.repo.repo}/${suffix}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token || job.githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "fly-dev",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

// Combined CI state for a commit: "success" (incl. no checks), "pending", "failure".
async function combinedChecks(job, token, sha) {
  const cr = await ghApi(job, token, `commits/${sha}/check-runs`)
    .then((r) => (r.ok ? r.json() : { check_runs: [] }))
    .catch(() => ({ check_runs: [] }));
  const st = await ghApi(job, token, `commits/${sha}/status`)
    .then((r) => (r.ok ? r.json() : { state: "" }))
    .catch(() => ({ state: "" }));
  const runs = cr.check_runs || [];
  const failed =
    st.state === "failure" ||
    runs.some((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion));
  if (failed) return "failure";
  const pending = st.state === "pending" || runs.some((r) => r.status !== "completed");
  return pending ? "pending" : "success";
}

// PR mergeability snapshot. GitHub computes `mergeable` asynchronously, so poll briefly.
async function prMergeStatus(job, token, prNumber) {
  let pr = null;
  for (let i = 0; i < 5; i += 1) {
    const res = await ghApi(job, token, `pulls/${prNumber}`);
    if (!res.ok) return { ok: false, reason: `pr_get_${res.status}` };
    pr = await res.json();
    if (pr.mergeable !== null && pr.mergeable_state !== "unknown") break;
    await sleep(2000);
  }
  const sha = pr.head?.sha;
  const checks = sha ? await combinedChecks(job, token, sha) : "success";
  return { ok: true, mergeable: pr.mergeable, draft: pr.draft, checks, headRef: pr.head?.ref, sha };
}

async function mergePr(job, token, prNumber, sha) {
  const res = await ghApi(job, token, `pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash", sha }),
  });
  if (res.ok) return { merged: true };
  return { merged: false, reason: `merge_http_${res.status}`, text: (await res.text()).slice(0, 300) };
}

// Merge ONLY when our local tests passed AND GitHub reports the PR mergeable with
// non-failing, non-pending checks. Returns {merged, reason}.
async function tryMerge(job, token, prNumber, gate) {
  if (gate.ran === true && gate.passed === false) return { merged: false, reason: "tests_failing" };
  const st = await prMergeStatus(job, token, prNumber);
  if (!st.ok) return { merged: false, reason: st.reason };
  if (st.draft) return { merged: false, reason: "draft" };
  // Require an affirmative mergeable=true (null = GitHub hasn't computed it yet).
  if (st.mergeable !== true) return { merged: false, reason: "not_mergeable" };
  if (st.checks === "failure") return { merged: false, reason: "checks_failing" };
  if (st.checks === "pending") return { merged: false, reason: "checks_pending" };
  step(job.runId, "merge:attempt", { prNumber });
  const m = await mergePr(job, token, prNumber, st.sha);
  step(job.runId, "merge:done", { merged: m.merged, reason: m.reason ?? null });
  return m;
}

// Fetch the latest base branch and merge it into the working branch; if that
// conflicts, have the agent resolve. Returns { ok, conflicts }.
async function syncWithBase(job, repoDir, baseBranch, remoteUrl) {
  await exec("git", ["fetch", remoteUrl, baseBranch], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  const merge = await exec("git", ["merge", "--no-edit", "FETCH_HEAD"], { cwd: repoDir });
  if (merge.code === 0) return { ok: true, conflicts: false };
  step(job.runId, "conflicts:resolve", {});
  const prompt =
    `Merging the base branch '${baseBranch}' produced git conflicts. Resolve ALL conflict ` +
    `markers correctly, preserving both the base changes and this branch's intent, then ` +
    `make sure the project still builds. Output:\n${tail(merge.stdout + "\n" + merge.stderr, 6000)}`;
  await runAgent(job, repoDir, prompt);
  await exec("git", ["add", "-A"], { cwd: repoDir });
  // Check the INDEX for leftover conflict markers (working tree may be staged).
  const unresolved = await exec("git", ["diff", "--cached", "--check"], { cwd: repoDir });
  const commit = await exec("git", ["commit", "--no-edit"], { cwd: repoDir });
  if (unresolved.code !== 0 || commit.code !== 0) {
    // Couldn't cleanly conclude the merge — abort so the branch stays pushable
    // rather than getting stuck in a half-merged state that blocks `git push`.
    step(job.runId, "conflicts:abort", { unresolved: unresolved.code, commit: commit.code });
    await exec("git", ["merge", "--abort"], { cwd: repoDir }).catch(() => {});
    return { ok: false, conflicts: true };
  }
  return { ok: true, conflicts: true };
}

// Collect human (non-bot) PR comments — both issue-level and inline review comments.
async function fetchPrComments(job, token, prNumber) {
  const issue = await ghApi(job, token, `issues/${prNumber}/comments?per_page=50`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const review = await ghApi(job, token, `pulls/${prNumber}/comments?per_page=50`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const lines = [
    ...review.map((c) => `[${c.path}:${c.line ?? "?"}] ${c.user?.login}: ${c.body}`),
    ...issue.map((c) => `${c.user?.login}: ${c.body}`),
  ].filter((t) => !/fly-dev\[bot\]/i.test(t) && t.trim().length > 0);
  return lines.join("\n\n").slice(0, 8000);
}

// "address_pr" mode: check out an existing PR branch, address its review comments,
// resolve conflicts, make tests pass, push, and merge when green.
async function handleAddressPr(job) {
  if (!job.runId || !job.repo?.owner || !job.repo?.repo || !job.prNumber) {
    return { ok: false, error: "missing_required_fields" };
  }
  const tokens = (
    Array.isArray(job.githubTokens) && job.githubTokens.length ? job.githubTokens : [job.githubToken]
  ).filter(Boolean);
  const repoPath = `github.com/${job.repo.owner}/${job.repo.repo}.git`;
  const cloneUrlFor = (t) => `https://x-access-token:${t}@${repoPath}`;
  const workdir = await mkdtemp(path.join(tmpdir(), `fly-pr-${job.prNumber}-`));
  const repoDir = path.join(workdir, job.repo.repo);
  try {
    step(job.runId, "clone:start", { mode: "address_pr", prNumber: job.prNumber });
    let activeToken = null;
    for (const t of tokens) {
      const c = await exec("git", ["clone", cloneUrlFor(t), repoDir], { timeoutMs: GIT_TIMEOUT_MS });
      if (c.code === 0) { activeToken = t; break; }
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!activeToken) return { ok: false, error: "clone_failed" };
    const pushUrl = cloneUrlFor(activeToken);

    const st = await prMergeStatus(job, activeToken, job.prNumber);
    if (!st.ok || !st.headRef) return { ok: false, error: "pr_not_found", logs: st.reason ?? "" };
    const headRef = st.headRef;
    const baseBranch = job.repo.baseBranch || "main";

    await exec("git", ["fetch", pushUrl, `refs/pull/${job.prNumber}/head`], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    const co = await exec("git", ["checkout", "-B", headRef, "FETCH_HEAD"], { cwd: repoDir });
    if (co.code !== 0) return { ok: false, error: "pr_checkout_failed", logs: co.stderr.slice(-2000) };
    await exec("git", ["config", "user.email", "fly-dev[bot]@users.noreply.github.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "fly-dev[bot]"], { cwd: repoDir });
    writeGitExclude(repoDir);

    const comments = (job.comments && String(job.comments)) || (await fetchPrComments(job, activeToken, job.prNumber));
    step(job.runId, "agent:start", { mode: "address_pr" });
    const startedAt = Date.now();
    await runAgent(
      job,
      repoDir,
      `Address the following pull-request review feedback by editing this branch, then stop. ` +
        `Keep changes focused on the feedback.\n\n${comments || "(no specific comments found — make the PR mergeable and green)"}`,
    );
    step(job.runId, "agent:done", { ms: Date.now() - startedAt });
    await commitAll(repoDir, `fix: address review comments [fly-dev run ${job.runId}]`);

    step(job.runId, "test:start");
    const gate = await ensureTestsPass(job, repoDir);
    step(job.runId, "sync:start", { baseBranch });
    await syncWithBase(job, repoDir, baseBranch, pushUrl);

    step(job.runId, "push:start", { headRef });
    const push = await exec("git", ["push", pushUrl, `HEAD:${headRef}`], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    if (push.code !== 0) return { ok: false, error: "push_failed", logs: push.stderr.slice(-2000) };
    step(job.runId, "push:done");

    const merge = await tryMerge(job, activeToken, job.prNumber, gate);
    return {
      ok: true,
      prNumber: job.prNumber,
      prUrl: `https://github.com/${job.repo.owner}/${job.repo.repo}/pull/${job.prNumber}`,
      merged: merge.merged === true,
      mergeReason: merge.reason ?? null,
      testsRun: gate.ran,
      testsPassed: gate.passed ?? null,
      projectType: gate.projectType,
      testSummary: tail(gate.summary, 2000),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
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

  // Detected from the clone — never assume "main" (many repos default to master).
  let baseBranch = job.repo.baseBranch || "main";
  const branch = `fly-dev/${job.runId}`;
  const workdir = await mkdtemp(path.join(tmpdir(), `fly-${job.runId}-`));
  const repoDir = path.join(workdir, job.repo.repo);
  // Candidate tokens to try, in order: the (least-privilege) primary, then the
  // OAuth fallback. The App installation token can 403 on private repos it isn't
  // installed on; the user's OAuth token has full `repo` access. We pick whichever
  // authenticates the clone and reuse it for the push.
  const tokens = (
    Array.isArray(job.githubTokens) && job.githubTokens.length
      ? job.githubTokens
      : [job.githubToken]
  ).filter(Boolean);
  const repoPath = `github.com/${job.repo.owner}/${job.repo.repo}.git`;
  const cloneUrlFor = (tok) => `https://x-access-token:${tok}@${repoPath}`;

  try {
    step(job.runId, "clone:start", { repo: `${job.repo.owner}/${job.repo.repo}`, baseBranch, tokenCandidates: tokens.length });
    let clone = { code: -1, stderr: "no token" };
    let activeToken = null;
    for (const tok of tokens) {
      // No --branch: clone the repo's DEFAULT branch (main, master, develop, …).
      clone = await exec(
        "git",
        ["clone", "--depth=1", cloneUrlFor(tok), repoDir],
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
    // Record the actual default branch we landed on (used as PR base + diff base).
    const headRef = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
    baseBranch = (headRef.stdout || "").trim() || baseBranch;
    step(job.runId, "clone:done", { baseBranch });
    const pushUrl = cloneUrlFor(activeToken);

    await exec("git", ["checkout", "-b", branch], { cwd: repoDir });
    await exec("git", ["config", "user.email", "fly-dev[bot]@users.noreply.github.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "fly-dev[bot]"], { cwd: repoDir });
    writeGitExclude(repoDir);

    step(job.runId, "agent:start", { provider: job.agentProvider ?? "claude-code" });
    const agentStartedAt = Date.now();
    const agent = await runAgent(job, repoDir, job.objective);
    step(job.runId, "agent:done", { exitCode: agent.code, ms: Date.now() - agentStartedAt });
    const summary = (agent.stdout || "").slice(-4000);
    const logs = (agent.stderr || "").slice(-4000);

    const status = await exec("git", ["status", "--porcelain"], { cwd: repoDir });
    if (!status.stdout.trim()) {
      // No diff. Distinguish a genuine no-op (agent exited 0) from an agent failure
      // (non-zero exit — e.g. expired Claude OAuth token, crash). The latter is
      // retryable and worth surfacing distinctly.
      const errored = agent.code !== 0;
      step(job.runId, errored ? "agent_error" : "no_changes", { exitCode: agent.code });
      return {
        ok: false,
        error: errored ? "agent_error" : "no_changes",
        agentExitCode: agent.code,
        summary,
        logs,
      };
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

    // Test gate WITH a fix loop: re-run the agent on failures until the suite
    // passes or we hit the attempt cap. Only a still-failing suite opens a draft.
    step(job.runId, "test:start");
    const gate = await ensureTestsPass(job, repoDir);
    const draft = gate.ran === true && gate.passed === false;

    // NOTE: the branch was just created from the freshly-cloned base, so it can't
    // conflict at open time. Conflict resolution (which needs full history) happens
    // in the address_pr flow when the base has since moved. tryMerge below refuses
    // to merge a PR GitHub reports as conflicted.
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
    const pr = await openPullRequest(job, branch, baseBranch, title, prBody, draft, activeToken);
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

    // Merge only on passing: local tests green + GitHub mergeable + checks not
    // failing/pending. If CI is still pending, the worker's merge reaper finishes it.
    const merge = await tryMerge(job, activeToken, pr.prNumber, gate);

    return {
      ok: true,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      prDraft: draft,
      merged: merge.merged === true,
      mergeReason: merge.reason ?? null,
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
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* handleRun reports invalid_json */ }
      const result =
        parsed && parsed.mode === "address_pr"
          ? await handleAddressPr(parsed)
          : await handleRun(body);
      return sendJson(response, 200, result);
    } catch (err) {
      return sendJson(response, 200, { ok: false, error: "exception", message: String(err) });
    }
  }
  return sendJson(response, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0");
