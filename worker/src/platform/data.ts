/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";

export type ConnectionSummary = {
  provider: "github" | "linear";
  status: string;
  accountName: string | null;
  updatedAt: string | null;
};

export type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  url: string | null;
  repoMappingStatus: string;
  repoConfidence: number;
  repoUrl: string | null;
  suggestedRepo: string | null;
  activeRuns: number;
  failedRuns: number;
};

export type GithubRepoSummary = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  private: number;
  archived: number;
  openIssues: number;
  stars: number;
  language: string | null;
  pushedAt: string | null;
};

export type UsageSummary = {
  events: number;
  modelCalls: number;
  containerMinutes: number;
  deploys: number;
  browserCalls: number;
  firecrawlCalls: number;
  artifactWrites: number;
  costMicros: number;
};

export type Overview = {
  user: CurrentUser | null;
  usage: UsageSummary;
  connections: ConnectionSummary[];
  queue: {
    configured: boolean;
    pendingApproximation: number;
  };
  projects: ProjectSummary[];
  repos: GithubRepoSummary[];
  recentRuns: RunRow[];
  recentArtifacts: ArtifactRow[];
  templates: TemplateRow[];
};

export type RunRow = {
  id: string;
  objective: string;
  status: string;
  projectId: string | null;
  projectName: string | null;
  autonomyMode: string;
  agentProvider: string;
  approvalRequired: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type ArtifactRow = {
  id: string;
  runId: string;
  kind: string;
  url: string | null;
  r2Key: string | null;
  createdAt: string;
};

export type TemplateRow = {
  id: string;
  kind: string;
  repo: string;
  description: string;
  status: string;
};

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function all<T extends Record<string, unknown>>(
  env: Env,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  try {
    const result = await env.DB.prepare(sql).bind(...values).all<T>();
    return result.results ?? [];
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function first<T extends Record<string, unknown>>(
  env: Env,
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await all<T>(env, sql, values);
  return rows[0] ?? null;
}

export async function runSql(env: Env, sql: string, values: unknown[] = []): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...values).run();
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

export async function ensureUser(
  env: Env,
  user: Omit<CurrentUser, "id"> & { id?: string },
): Promise<CurrentUser> {
  const userId = user.id ?? id("user");
  await runSql(
    env,
    `INSERT INTO app_users (id, email, name, fly_user_slug, auth_source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fly_user_slug) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       auth_source = excluded.auth_source,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, user.email, user.name, user.flyUserSlug, user.authSource],
  );

  const stored = await first<{
    id: string;
    email: string | null;
    name: string | null;
    fly_user_slug: string;
    auth_source: CurrentUser["authSource"];
  }>(
    env,
    `SELECT id, email, name, fly_user_slug, auth_source
     FROM app_users
     WHERE fly_user_slug = ?`,
    [user.flyUserSlug],
  );

  return {
    id: stored?.id ?? userId,
    email: stored?.email ?? user.email,
    name: stored?.name ?? user.name,
    flyUserSlug: stored?.fly_user_slug ?? user.flyUserSlug,
    authSource: stored?.auth_source ?? user.authSource,
  };
}

export async function getUsage(env: Env, userId: string): Promise<UsageSummary> {
  const rows = await all<{
    category: string;
    events: number;
    quantity: number;
    cost_micros: number;
  }>(
    env,
    `SELECT category, COUNT(*) AS events, COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(cost_micros), 0) AS cost_micros
     FROM usage_events
     WHERE user_id = ?
     GROUP BY category`,
    [userId],
  );

  const summary: UsageSummary = {
    events: 0,
    modelCalls: 0,
    containerMinutes: 0,
    deploys: 0,
    browserCalls: 0,
    firecrawlCalls: 0,
    artifactWrites: 0,
    costMicros: 0,
  };

  for (const row of rows) {
    summary.events += Number(row.events);
    summary.costMicros += Number(row.cost_micros);
    if (row.category === "model_call") summary.modelCalls += Number(row.quantity);
    if (row.category === "container_runtime") summary.containerMinutes += Number(row.quantity);
    if (row.category === "deploy") summary.deploys += Number(row.quantity);
    if (row.category === "browser_call") summary.browserCalls += Number(row.quantity);
    if (row.category === "firecrawl_call") summary.firecrawlCalls += Number(row.quantity);
    if (row.category === "artifact_write") summary.artifactWrites += Number(row.quantity);
  }

  return summary;
}

export async function getProjects(env: Env): Promise<ProjectSummary[]> {
  return all<ProjectSummary>(
    env,
    `SELECT
       p.id,
       p.name,
       p.status,
       p.url,
       p.repo_mapping_status AS repoMappingStatus,
       p.repo_confidence AS repoConfidence,
       (SELECT url FROM repository_mappings
          WHERE linear_project_id = p.id AND status = 'active' LIMIT 1) AS repoUrl,
       (SELECT owner || '/' || repo FROM repository_mappings
          WHERE linear_project_id = p.id AND status = 'suggested'
          ORDER BY confidence DESC LIMIT 1) AS suggestedRepo,
       COALESCE(SUM(CASE WHEN r.status IN ('queued', 'waiting_approval', 'running') THEN 1 ELSE 0 END), 0) AS activeRuns,
       COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedRuns
     FROM linear_projects p
     LEFT JOIN runs r ON r.project_id = p.id
     GROUP BY p.id
     ORDER BY activeRuns DESC, p.synced_at DESC
     LIMIT 50`,
  );
}

export async function getGithubRepos(env: Env, userId: string): Promise<GithubRepoSummary[]> {
  return all<GithubRepoSummary>(
    env,
    `SELECT
       id,
       owner,
       name,
       full_name AS fullName,
       url,
       description,
       private,
       archived,
       open_issues AS openIssues,
       stars,
       language,
       pushed_at AS pushedAt
     FROM github_repos
     WHERE user_id = ?
     ORDER BY pushed_at DESC
     LIMIT 500`,
    [userId],
  );
}

export async function getRuns(env: Env, userId: string, projectId?: string): Promise<RunRow[]> {
  const values = projectId ? [userId, projectId] : [userId];
  return all<RunRow>(
    env,
    `SELECT
       r.id,
       r.objective,
       r.status,
       r.project_id AS projectId,
       p.name AS projectName,
       r.autonomy_mode AS autonomyMode,
       r.agent_provider AS agentProvider,
       r.approval_required AS approvalRequired,
       r.created_at AS createdAt,
       r.updated_at AS updatedAt,
       r.last_error AS lastError
     FROM runs r
     LEFT JOIN linear_projects p ON p.id = r.project_id
     WHERE r.user_id = ? ${projectId ? "AND r.project_id = ?" : ""}
     ORDER BY r.created_at DESC
     LIMIT 25`,
    values,
  );
}

export async function getOverview(env: Env, user: CurrentUser | null): Promise<Overview> {
  const userId = user?.id ?? "anonymous";
  const [usage, projects, repos, recentRuns, recentArtifacts, templates, connections] =
    await Promise.all([
      user ? getUsage(env, user.id) : demoUsage(),
      getProjects(env),
      user ? getGithubRepos(env, user.id) : Promise.resolve([]),
      user ? getRuns(env, user.id) : Promise.resolve([]),
      all<ArtifactRow>(
        env,
        `SELECT id, run_id AS runId, kind, url, r2_key AS r2Key, created_at AS createdAt
         FROM artifacts
         ORDER BY created_at DESC
         LIMIT 10`,
      ),
      all<TemplateRow>(
        env,
        `SELECT id, kind, repo, description, status
         FROM templates
         ORDER BY kind`,
      ),
      all<ConnectionSummary>(
        env,
        `SELECT provider, status, account_name AS accountName, updated_at AS updatedAt
         FROM account_connections
         WHERE user_id = ?
         ORDER BY provider`,
        [userId],
      ),
    ]);

  return {
    user,
    usage,
    connections: connections.length > 0 ? connections : defaultConnections(),
    queue: {
      configured: Boolean(env.WORK_QUEUE),
      pendingApproximation: recentRuns.filter((run) => run.status === "queued").length,
    },
    projects: projects.length > 0 ? projects : demoProjects(),
    repos,
    recentRuns,
    recentArtifacts,
    templates: templates.length > 0 ? templates : defaultTemplates(env),
  };
}

export async function recordRunEvent(
  env: Env,
  runId: string,
  eventType: string,
  message: string,
  severity = "info",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO run_events (run_id, event_type, message, severity, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, eventType, message, severity, JSON.stringify(metadata)],
  );
}

export async function recordUsage(
  env: Env,
  userId: string,
  category: string,
  options: {
    projectId?: string | null;
    runId?: string | null;
    provider?: string | null;
    quantity?: number;
    unit?: string;
    costMicros?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO usage_events
       (user_id, project_id, run_id, category, provider, quantity, unit, cost_micros, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      options.projectId ?? null,
      options.runId ?? null,
      category,
      options.provider ?? null,
      options.quantity ?? 1,
      options.unit ?? "event",
      options.costMicros ?? 0,
      JSON.stringify(options.metadata ?? {}),
    ],
  );
}

function isMissingTableError(error: unknown): boolean {
  // Only tolerate a genuinely-absent table (first boot before migrations run).
  // "D1_ERROR" is D1's generic prefix on nearly all runtime errors (constraint,
  // type, SQL), so matching it would silently swallow real write failures.
  // See SANDBOX_REVIEW.md B1.
  return error instanceof Error && /no such table/i.test(error.message);
}

function defaultConnections(): ConnectionSummary[] {
  return [
    { provider: "github", status: "needs_connection", accountName: null, updatedAt: null },
    { provider: "linear", status: "needs_connection", accountName: null, updatedAt: null },
  ];
}

function defaultTemplates(env: Env): TemplateRow[] {
  return [
    {
      id: "template_cloudflare_fullstack",
      kind: "cloudflare-fullstack",
      repo: env.CLOUDFLARE_TEMPLATE_REPO,
      description: "Cloudflare Workers/Pages full-stack app template.",
      status: "active",
    },
    {
      id: "template_apple_multiplatform",
      kind: "apple-multiplatform",
      repo: env.APPLE_TEMPLATE_REPO,
      description: "SwiftUI multiplatform template for iOS, iPadOS, macOS, and watchOS.",
      status: "active",
    },
  ];
}

function demoProjects(): ProjectSummary[] {
  return [
    {
      id: "linear_pending",
      name: "Connect Linear to sync projects",
      status: "setup",
      url: null,
      repoMappingStatus: "unmapped",
      repoConfidence: 0,
      repoUrl: null,
      suggestedRepo: null,
      activeRuns: 0,
      failedRuns: 0,
    },
  ];
}

function demoUsage(): UsageSummary {
  return {
    events: 0,
    modelCalls: 0,
    containerMinutes: 0,
    deploys: 0,
    browserCalls: 0,
    firecrawlCalls: 0,
    artifactWrites: 0,
    costMicros: 0,
  };
}

// One-time, idempotent reconciliation: fold every OTHER user's user-scoped rows
// into `intoUserId`. The Wave 1 auth migration minted a new app_users row for the
// same human, orphaning repos/runs/usage under the old id (see the 2026-06-02
// spec). Re-pointable tables are UPDATEd; account_connections cannot be re-pointed
// (UNIQUE(user_id, provider)) so legacy duplicates are deleted (the canonical user
// keeps its own). github_repos has UNIQUE(user_id, github_id) so orphaned duplicates
// are deleted first before re-pointing (see repointGithubRepos). Idempotent: a second
// run matches no rows. Single-operator tool — this collapses all identities into one;
// do not use as-is for true multi-tenancy.
export async function reclaimUserData(
  env: Env,
  intoUserId: string,
): Promise<{ repos: number; runs: number; usage: number; memories: number; connectionsDropped: number }> {
  const repos = await repointGithubRepos(env, intoUserId);
  const runs = await repointUser(env, "runs", intoUserId);
  const usage = await repointUser(env, "usage_events", intoUserId);
  const memories = await repointUser(env, "agent_memories", intoUserId);
  const dropped = await env.DB.prepare(
    "DELETE FROM account_connections WHERE user_id != ?",
  )
    .bind(intoUserId)
    .run();
  return {
    repos,
    runs,
    usage,
    memories,
    connectionsDropped: dropped.meta.changes ?? 0,
  };
}

// github_repos has UNIQUE(user_id, github_id), so a blind re-point collides when the
// canonical user already synced the same repo. Drop orphaned duplicates first (the
// canonical copy wins — repos are re-syncable), then re-point the rest. Idempotent.
async function repointGithubRepos(env: Env, intoUserId: string): Promise<number> {
  await env.DB.prepare(
    `DELETE FROM github_repos
     WHERE user_id != ?
       AND github_id IN (SELECT github_id FROM github_repos WHERE user_id = ?)`,
  )
    .bind(intoUserId, intoUserId)
    .run();
  const res = await env.DB.prepare(
    `UPDATE github_repos SET user_id = ? WHERE user_id != ?`,
  )
    .bind(intoUserId, intoUserId)
    .run();
  return res.meta.changes ?? 0;
}

// `table` is from a fixed internal allowlist (never user input) so interpolation
// is safe here.
async function repointUser(env: Env, table: string, intoUserId: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE ${table} SET user_id = ? WHERE user_id != ?`,
  )
    .bind(intoUserId, intoUserId)
    .run();
  return res.meta.changes ?? 0;
}

export async function getActiveRunCount(env: Env): Promise<number> {
  const res = await first<{ count: number }>(env, "SELECT count(*) as count FROM runs WHERE status = 'running'");
  return res?.count ?? 0;
}
