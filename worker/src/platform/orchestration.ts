/* AGPL-3.0-or-later */
import type { CurrentUser, Env, RunRepoCoords, RunWorkflowParams, WorkQueueMessage } from "../env";
import { first, id, recordRunEvent, recordUsage, runSql } from "./data";
import { redactSecrets } from "./crypto";
import { getDecryptedToken } from "./integrations";
import { getInstallationToken } from "./github";

export type CreateTaskPayload = {
  objective?: string;
  goal?: string;
  linearProjectId?: string;
  linearIssueId?: string;
  linearTeamId?: string;
  repoMappingId?: string;
  repoOwner?: string;
  repoName?: string;
  agentProvider?: "codex" | "claude-code";
  autonomyMode?: "manual_approval" | "auto_review" | "auto_eligible";
  source?: string;
};

export type CreateTemplateAppPayload = {
  kind?: "cloudflare-fullstack" | "apple-multiplatform";
  linearProjectId?: string;
  repoName?: string;
  visibility?: "public" | "private" | "internal";
};

// Non-secret execution plan for a run, resolved from D1. Safe to persist in
// Workflow step state. Secrets are resolved separately, inside the step that
// uses them (see prepareRunCredentials) so they never enter durable storage.
export type RunPlan = {
  userId: string;
  projectId: string | null;
  objective: string;
  agentProvider: string;
  repo: RunRepoCoords | null;
  linearIssueId: string | null;
  linearTeamId: string | null;
};

export async function createTaskRun(env: Env, user: CurrentUser, payload: CreateTaskPayload) {
  const objective = redactSecrets((payload.objective ?? payload.goal ?? "").trim());
  if (objective.length < 4) {
    return Response.json({ error: "Task objective is required" }, { status: 400 });
  }

  // The REQUIRE_HUMAN_APPROVAL operator switch overrides any caller-supplied
  // autonomyMode — webhook-triggered runs always require approval before they
  // can mutate a repository. See SANDBOX_REVIEW.md B3.
  const forceApproval = env.REQUIRE_HUMAN_APPROVAL === "true";
  const approvalRequired = forceApproval || payload.autonomyMode !== "auto_eligible" ? 1 : 0;
  const status = approvalRequired ? "waiting_approval" : "queued";

  const runId = id("run");
  await runSql(
    env,
    `INSERT INTO runs
       (id, user_id, project_id, repo_mapping_id, objective, status, autonomy_mode, agent_provider, approval_required, linear_issue_id, linear_team_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      user.id,
      payload.linearProjectId ?? null,
      payload.repoMappingId ?? null,
      objective,
      status,
      payload.autonomyMode ?? "manual_approval",
      payload.agentProvider ?? "claude-code",
      approvalRequired,
      payload.linearIssueId ?? null,
      payload.linearTeamId ?? null,
      JSON.stringify({
        source: payload.source ?? "dev.fly.pm",
        linearIssueId: payload.linearIssueId ?? null,
        linearTeamId: payload.linearTeamId ?? null,
        repoOwner: payload.repoOwner ?? null,
        repoName: payload.repoName ?? null,
      }),
    ],
  );

  await recordRunEvent(
    env,
    runId,
    "run.created",
    approvalRequired
      ? "Run created and waiting for human approval."
      : "Run created and queued for sandbox execution.",
    "info",
    { approvalRequired: Boolean(approvalRequired) },
  );
  await recordUsage(env, user.id, "orchestration_event", {
    runId,
    projectId: payload.linearProjectId,
    metadata: { action: "create_task" },
  });

  if (!approvalRequired) {
    await enqueueRun(env, {
      runId,
      userId: user.id,
      projectId: payload.linearProjectId,
      action: "start-run",
    });
  }

  return Response.json({ id: runId, status, approvalRequired: Boolean(approvalRequired) }, { status: 201 });
}

export async function approveRun(env: Env, user: CurrentUser, runId: string) {
  // Status-filtered, idempotent transition: a second approval (or a replayed
  // request) changes no rows and must not enqueue a duplicate. See B2.
  const update = await env.DB.prepare(
    `UPDATE runs
     SET status = 'queued', approval_required = 0, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'waiting_approval'`,
  )
    .bind(runId, user.id)
    .run();

  if (!update.meta.changes) {
    return Response.json({ id: runId, status: "noop" });
  }

  const run = await first<{ project_id: string | null }>(
    env,
    "SELECT project_id FROM runs WHERE id = ?",
    [runId],
  );

  await runSql(
    env,
    `INSERT INTO approvals (id, run_id, user_id, action, status, decided_at)
     VALUES (?, ?, ?, 'start-run', 'approved', CURRENT_TIMESTAMP)`,
    [id("approval"), runId, user.id],
  );
  await recordRunEvent(env, runId, "run.approved", "Human approval received; run queued.", "info");
  await enqueueRun(env, {
    runId,
    userId: user.id,
    projectId: run?.project_id ?? undefined,
    action: "start-run",
  });
  return Response.json({ id: runId, status: "queued" });
}

export async function cancelRun(env: Env, user: CurrentUser, runId: string) {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status IN ('queued', 'waiting_approval', 'running')`,
    [runId, user.id],
  );
  await recordRunEvent(env, runId, "run.cancelled", "Run cancelled by user.", "warn");
  return Response.json({ id: runId, status: "cancelled" });
}

export async function createTemplateApp(
  env: Env,
  user: CurrentUser,
  payload: CreateTemplateAppPayload,
) {
  if (!payload.kind || !payload.repoName || !payload.linearProjectId) {
    return Response.json(
      { error: "kind, repoName, and linearProjectId are required" },
      { status: 400 },
    );
  }

  const templateRepo =
    payload.kind === "cloudflare-fullstack" ? env.CLOUDFLARE_TEMPLATE_REPO : env.APPLE_TEMPLATE_REPO;
  const objective =
    `Create ${payload.kind} app repo ${payload.repoName} from ${templateRepo}, ` +
    `link it to Linear project ${payload.linearProjectId}, and prepare the first verified run.`;

  const response = await createTaskRun(env, user, {
    objective,
    linearProjectId: payload.linearProjectId,
    agentProvider: "codex",
    autonomyMode: "manual_approval",
  });

  await recordUsage(env, user.id, "template_app_request", {
    projectId: payload.linearProjectId,
    metadata: {
      kind: payload.kind,
      repoName: payload.repoName,
      visibility: payload.visibility ?? "private",
      templateRepo,
    },
  });

  return response;
}

export async function startRunWorkflow(env: Env, params: RunWorkflowParams): Promise<void> {
  try {
    await env.RUN_WORKFLOW.create({
      id: params.runId,
      params,
      retention: {
        successRetention: "30 days",
        errorRetention: "90 days",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Idempotent: a run starts exactly once. A duplicate enqueue or queue
    // redelivery must not clobber the in-flight instance. See SANDBOX_REVIEW.md B2.
    if (/already exists|instance.*exist/i.test(message)) {
      return;
    }
    throw error;
  }
}

export async function enqueueRun(env: Env, message: WorkQueueMessage): Promise<void> {
  await env.WORK_QUEUE.send(message);
}

export async function markRunStarted(env: Env, runId: string, sandboxId: string): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'running', sandbox_id = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [sandboxId, runId],
  );
  await recordRunEvent(env, runId, "container.start", "Sandbox container start requested.", "info", {
    sandboxId,
  });
}

export async function markRunCompleted(
  env: Env,
  runId: string,
  result: { prUrl?: string | null; commitSha?: string | null; branchName?: string | null },
): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'completed', pr_url = ?, commit_sha = ?, branch_name = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [result.prUrl ?? null, result.commitSha ?? null, result.branchName ?? null, runId],
  );
  await recordRunEvent(env, runId, "run.completed", "Run completed.", "info", {
    prUrl: result.prUrl ?? null,
  });
}

export async function markRunFailed(env: Env, runId: string, error: unknown): Promise<void> {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  await runSql(
    env,
    `UPDATE runs
     SET status = 'failed', last_error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [message, runId],
  );
  await recordRunEvent(env, runId, "run.failed", message, "error");
}

// Resolve the non-secret execution plan for a run from D1.
export async function resolveRunPlan(env: Env, runId: string): Promise<RunPlan | null> {
  const run = await first<{
    objective: string;
    agent_provider: string;
    project_id: string | null;
    repo_mapping_id: string | null;
    user_id: string;
    metadata_json: string;
  }>(
    env,
    `SELECT objective, agent_provider, project_id, repo_mapping_id, user_id, metadata_json
     FROM runs WHERE id = ?`,
    [runId],
  );
  if (!run) return null;

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
  } catch {
    meta = {};
  }

  const metaOwner = typeof meta.repoOwner === "string" ? meta.repoOwner : null;
  const metaRepo = typeof meta.repoName === "string" ? meta.repoName : null;
  const repo =
    metaOwner && metaRepo
      ? { owner: metaOwner, repo: metaRepo, baseBranch: "main", url: `https://github.com/${metaOwner}/${metaRepo}` }
      : await resolveRepoCoords(env, run.repo_mapping_id, run.project_id);

  return {
    userId: run.user_id,
    projectId: run.project_id,
    objective: run.objective,
    agentProvider: run.agent_provider,
    repo,
    linearIssueId: typeof meta.linearIssueId === "string" ? meta.linearIssueId : null,
    linearTeamId: typeof meta.linearTeamId === "string" ? meta.linearTeamId : null,
  };
}

// Resolve secrets for a run. Call ONLY inside the Workflow step that uses them
// so they are never returned from a step (never written to durable storage).
export async function prepareRunCredentials(
  env: Env,
  plan: RunPlan,
): Promise<{
  githubToken: string | null;
  linearToken: string | null;
  aiGateway: { url: string; token: string } | null;
  claudeOauthToken: string | null;
}> {
  let githubToken = await getDecryptedToken(env, plan.userId, "github");

  // Prefer a least-privilege GitHub App installation token scoped to the single
  // repo over the broad user OAuth token. See SANDBOX_REVIEW.md S3.
  if (plan.repo && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    const installationToken = await getInstallationToken(env, plan.repo.owner, plan.repo.repo).catch(
      () => null,
    );
    if (installationToken) {
      githubToken = installationToken;
    }
  }

  const linearToken = await getDecryptedToken(env, plan.userId, "linear");

  // For codex (OpenAI-compatible Messages API), keep gateway routing so calls
  // are observed + cost-tracked centrally.
  const aiGateway =
    env.CF_AIG_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
      ? {
          url: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID || "x"}/anthropic`,
          token: env.CF_AIG_TOKEN,
        }
      : null;

  // For claude-code we bypass the gateway entirely: a long-lived OAuth token
  // (`claude setup-token`) bills against the user's Claude Pro/Max subscription
  // — the gateway only proxies API-key auth, not OAuth/subscription auth.
  const claudeOauthToken = env.CLAUDE_CODE_OAUTH_TOKEN ?? null;

  return { githubToken, linearToken, aiGateway, claudeOauthToken };
}

async function resolveRepoCoords(
  env: Env,
  repoMappingId: string | null,
  projectId: string | null,
): Promise<RunRepoCoords | null> {
  let row: { owner: string; repo: string; url: string } | null = null;
  if (repoMappingId) {
    row = await first<{ owner: string; repo: string; url: string }>(
      env,
      "SELECT owner, repo, url FROM repository_mappings WHERE id = ?",
      [repoMappingId],
    );
  }
  if (!row && projectId) {
    row = await first<{ owner: string; repo: string; url: string }>(
      env,
      `SELECT owner, repo, url FROM repository_mappings
       WHERE linear_project_id = ? AND status = 'active'
       ORDER BY confidence DESC LIMIT 1`,
      [projectId],
    );
  }
  if (!row) return null;
  return { owner: row.owner, repo: row.repo, url: row.url, baseBranch: "main" };
}

// Create a run and, when CONTINUE_AUTONOMY is enabled, immediately approve it so it
// queues without a human checkpoint — bypassing REQUIRE_HUMAN_APPROVAL for the
// operator-opted-in Continue flow. Reuses createTaskRun (creation + redaction +
// usage) and approveRun (queue transition + approval audit row) so there is one
// code path for run creation. When autonomy is off, the run is left
// waiting_approval like any other.
export async function createAutonomousRun(
  env: Env,
  user: CurrentUser,
  payload: CreateTaskPayload,
): Promise<{ id: string; status: string }> {
  const response = await createTaskRun(env, user, {
    ...payload,
    autonomyMode: payload.autonomyMode ?? "auto_eligible",
  });
  const body = (await response.json()) as { id?: string; status?: string; error?: string };
  if (!body.id) {
    throw new Error(body.error ?? "Failed to create run");
  }
  if (env.CONTINUE_AUTONOMY === "true" && body.status === "waiting_approval") {
    await approveRun(env, user, body.id);
    return { id: body.id, status: "queued" };
  }
  return { id: body.id, status: body.status ?? "unknown" };
}
