/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { decryptText, encryptText, hmacHex, timingSafeEqual } from "./crypto";
import { all, first, id, runSql } from "./data";
import {
  extractGitHubReposFromText,
  matchProjectToRepo,
  repoMappingStatus,
  type RepoCandidate,
  type RepoLike,
} from "./repo-mapping";

export type OAuthProvider = "github" | "linear";

export type OAuthConnectResult =
  | { setupRequired: true; provider: OAuthProvider; missing: string[] }
  | { setupRequired: false; provider: OAuthProvider; url: string };

export async function createOAuthConnectUrl(
  provider: OAuthProvider,
  request: Request,
  env: Env,
  user: CurrentUser,
): Promise<OAuthConnectResult> {
  const appUrl = new URL(env.APP_URL || request.url);
  const redirectUri = `${appUrl.origin}/api/integrations/${provider}/callback`;
  const state = await createOAuthState(env, provider, user.id, redirectUri);

  if (provider === "github") {
    const missing = missingVars(env, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    if (missing.length > 0) {
      return { setupRequired: true, provider, missing };
    }

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "repo read:org read:user user:email workflow");
    url.searchParams.set("state", state);
    return { setupRequired: false, provider, url: url.toString() };
  }

  const missing = missingVars(env, ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]);
  if (missing.length > 0) {
    return { setupRequired: true, provider, missing };
  }

  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", env.LINEAR_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // Linear expects a COMMA-separated scope list, unlike GitHub's space-separated
  // form. Space-separated values are read as a single invalid scope. See
  // https://linear.app/developers/oauth-2-0-authentication
  url.searchParams.set("scope", "read,write,issues:create");
  url.searchParams.set("state", state);
  return { setupRequired: false, provider, url: url.toString() };
}

export async function handleOAuthCallback(
  provider: OAuthProvider,
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return Response.json({ error: "Missing OAuth code or state" }, { status: 400 });
  }

  const stateRecord = await consumeOAuthState(env, provider, state);
  if (!stateRecord) {
    return Response.json({ error: "Invalid or expired OAuth state" }, { status: 400 });
  }

  // Fail fast rather than silently storing NULL tokens when the key is missing.
  // See SANDBOX_REVIEW.md A6.
  if (!env.TOKEN_ENCRYPTION_KEY) {
    return Response.json(
      { error: "TOKEN_ENCRYPTION_KEY is not configured; cannot store OAuth tokens" },
      { status: 500 },
    );
  }

  const redirectUri = stateRecord.redirectUri;
  const token = provider === "github"
    ? await exchangeGitHubCode(env, code, redirectUri)
    : await exchangeLinearCode(env, code, redirectUri);

  const encryptedAccessToken = await encryptText(token.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await encryptText(token.refreshToken ?? "", env.TOKEN_ENCRYPTION_KEY);

  await runSql(
    env,
    `INSERT INTO account_connections
       (id, user_id, provider, external_account_id, account_name, access_token_encrypted, refresh_token_encrypted, scopes, expires_at, status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       external_account_id = excluded.external_account_id,
       account_name = excluded.account_name,
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       scopes = excluded.scopes,
       expires_at = excluded.expires_at,
       status = 'connected',
       metadata_json = excluded.metadata_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      id("conn"),
      stateRecord.userId,
      provider,
      token.externalAccountId,
      token.accountName,
      encryptedAccessToken,
      encryptedRefreshToken,
      token.scopes,
      token.expiresAt,
      JSON.stringify(token.metadata),
    ],
  );

  // Projects only otherwise sync via webhooks (no initial backfill), so pull the
  // full list immediately after a successful Linear connect. Best-effort: never
  // block or fail the connect redirect on a backfill error.
  if (provider === "linear") {
    await backfillLinearProjects(env, stateRecord.userId).catch(() => undefined);
  }

  return Response.redirect(`${env.APP_URL}/?connected=${provider}`, 302);
}

export async function verifyWebhook(
  provider: OAuthProvider,
  request: Request,
  env: Env,
  body: string,
): Promise<boolean> {
  if (provider === "github") {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");
    if (!secret || !signature) return false;
    const expected = `sha256=${await hmacHex(secret, body)}`;
    return timingSafeEqual(signature, expected);
  }

  const secret = env.LINEAR_WEBHOOK_SECRET;
  const signature =
    request.headers.get("linear-signature") ?? request.headers.get("x-linear-signature");
  if (!secret || !signature) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(signature.replace(/^sha256=/, ""), expected);
}

// Persist a webhook delivery. Uses INSERT OR IGNORE against the
// UNIQUE(provider, event_id) index (migration 0002) so retried deliveries are
// deduplicated. Returns isNew=false when the delivery was a duplicate so the
// caller can skip re-dispatching a run. See SANDBOX_REVIEW.md B4.
export async function storeWebhook(
  env: Env,
  provider: OAuthProvider,
  body: string,
  signatureValid: boolean,
  eventId: string | null,
  eventType: string | null,
): Promise<{ isNew: boolean }> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events
       (id, provider, event_id, event_type, signature_valid, payload_json, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(id("webhook"), provider, eventId, eventType, signatureValid ? 1 : 0, body)
    .run();
  return { isNew: Boolean(result.meta.changes) };
}

export async function syncLinearProjectFromPayload(
  env: Env,
  payload: Record<string, unknown>,
): Promise<{ projectId: string | null; candidates: RepoCandidate[] }> {
  const data = (payload.data ?? payload.project ?? payload) as Record<string, unknown>;
  const projectId = stringValue(data.id);
  const name = stringValue(data.name);
  if (!projectId || !name) {
    return { projectId: null, candidates: [] };
  }

  const description = stringValue(data.description) ?? "";
  const summary = stringValue(data.summary);
  const url = stringValue(data.url);
  const candidates = extractGitHubReposFromText(`${description}\n${summary ?? ""}\n${url ?? ""}`);
  const mapping = repoMappingStatus(candidates);

  await runSql(
    env,
    `INSERT INTO linear_projects
       (id, name, slug, status, url, summary, description, repo_mapping_status, repo_confidence, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       status = excluded.status,
       url = excluded.url,
       summary = excluded.summary,
       description = excluded.description,
       repo_mapping_status = excluded.repo_mapping_status,
       repo_confidence = excluded.repo_confidence,
       updated_at = excluded.updated_at,
       synced_at = CURRENT_TIMESTAMP`,
    [
      projectId,
      name,
      stringValue(data.slug),
      stringValue(data.status) ?? stringValue(data.state) ?? "unknown",
      url,
      summary,
      description,
      mapping.status,
      mapping.best?.confidence ?? 0,
      stringValue(data.updatedAt),
    ],
  );

  if (mapping.best) {
    await upsertRepositoryMapping(env, projectId, mapping.best, mapping.status);
  }

  return { projectId, candidates };
}

export async function upsertRepositoryMapping(
  env: Env,
  projectId: string,
  candidate: RepoCandidate,
  status: "mapped" | "needs_review" | "unmapped" = "mapped",
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO repository_mappings
       (id, linear_project_id, owner, repo, url, confidence, source, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(linear_project_id, provider, owner, repo) DO UPDATE SET
       url = excluded.url,
       confidence = excluded.confidence,
       source = excluded.source,
       status = excluded.status,
       updated_at = CURRENT_TIMESTAMP`,
    [
      id("repo"),
      projectId,
      candidate.owner,
      candidate.repo,
      candidate.url,
      candidate.confidence,
      candidate.source,
      status === "mapped" ? "active" : "needs_review",
    ],
  );
}

async function createOAuthState(
  env: Env,
  provider: OAuthProvider,
  userId: string,
  redirectUri: string,
): Promise<string> {
  const state = id("oauth");
  await env.SESSION_CACHE.put(
    `oauth:${provider}:${state}`,
    JSON.stringify({ userId, redirectUri }),
    { expirationTtl: 600 },
  );
  return state;
}

async function consumeOAuthState(
  env: Env,
  provider: OAuthProvider,
  state: string,
): Promise<{ userId: string; redirectUri: string } | null> {
  const key = `oauth:${provider}:${state}`;
  const raw = await env.SESSION_CACHE.get(key);
  if (!raw) return null;
  await env.SESSION_CACHE.delete(key);
  return JSON.parse(raw) as { userId: string; redirectUri: string };
}

async function exchangeGitHubCode(env: Env, code: string, redirectUri: string) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    scope?: string;
    error_description?: string;
  };
  if (!token.access_token) {
    throw new Error(token.error_description ?? "GitHub OAuth exchange failed");
  }

  const user = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "fly-dev",
    },
  }).then((res) => res.json() as Promise<{ id?: number; login?: string; name?: string }>);

  return {
    accessToken: token.access_token,
    refreshToken: null,
    scopes: token.scope ?? "",
    expiresAt: null,
    externalAccountId: user.id ? String(user.id) : null,
    accountName: user.login ?? user.name ?? "GitHub",
    metadata: { login: user.login },
  };
}

async function exchangeLinearCode(env: Env, code: string, redirectUri: string) {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID ?? "",
      client_secret: env.LINEAR_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!token.access_token) {
    throw new Error(token.error_description ?? "Linear OAuth exchange failed");
  }

  const viewer = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "{ viewer { id name email } }" }),
  }).then((res) => res.json() as Promise<{ data?: { viewer?: { id: string; name: string; email: string } } }>);

  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null;

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    scopes: token.scope ?? "",
    expiresAt,
    externalAccountId: viewer.data?.viewer?.id ?? null,
    accountName: viewer.data?.viewer?.name ?? viewer.data?.viewer?.email ?? "Linear",
    metadata: { email: viewer.data?.viewer?.email },
  };
}

function missingVars(env: Env, keys: Array<keyof Env>): string[] {
  return keys.filter((key) => !env[key]).map(String);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function getConnectedToken(env: Env, userId: string, provider: OAuthProvider) {
  return first<{ access_token_encrypted: string | null }>(
    env,
    `SELECT access_token_encrypted FROM account_connections
     WHERE user_id = ? AND provider = ? AND status = 'connected'`,
    [userId, provider],
  );
}

// Decrypt a stored provider token for use inside a Workflow step. The plaintext
// must never be returned from a step or logged. See SANDBOX_REVIEW.md S6.
export async function getDecryptedToken(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<string | null> {
  const row = await getConnectedToken(env, userId, provider);
  if (!row?.access_token_encrypted) {
    return null;
  }
  return decryptText(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
}

export async function listKnownConnections(env: Env, userId: string) {
  return all(
    env,
    `SELECT provider, status, account_name, updated_at
     FROM account_connections
     WHERE user_id = ?
     ORDER BY provider`,
    [userId],
  );
}

type LinearProjectNode = {
  id: string;
  name: string;
  url?: string | null;
  description?: string | null;
  state?: string | null;
  updatedAt?: string | null;
};

// Pull every project from the connected Linear workspace and upsert each through
// the same path webhooks use (so repository mapping is computed consistently).
// Linear otherwise never sends a full list — only per-event webhooks — so without
// this a freshly connected workspace shows only the projects that happened to
// fire an event. Returns how many projects were synced.
export async function backfillLinearProjects(
  env: Env,
  userId: string,
): Promise<{ synced: number; reason?: string }> {
  const token = await getDecryptedToken(env, userId, "linear");
  if (!token) {
    return { synced: 0, reason: "Linear is not connected" };
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query:
        "{ projects(first: 250) { nodes { id name url description state updatedAt } } }",
    }),
  });

  const json = (await response.json()) as {
    data?: { projects?: { nodes?: LinearProjectNode[] } };
  };
  const nodes = json.data?.projects?.nodes ?? [];

  for (const project of nodes) {
    await syncLinearProjectFromPayload(env, {
      data: {
        id: project.id,
        name: project.name,
        url: project.url ?? null,
        description: project.description ?? null,
        status: project.state ?? null,
        updatedAt: project.updatedAt ?? null,
      },
    });
  }

  // Map any newly-synced projects to repos by name. Best-effort.
  await autoMapProjects(env, userId).catch(() => undefined);

  return { synced: nodes.length };
}

type GithubRepoNode = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string | null;
  open_issues_count: number;
  stargazers_count: number;
  language: string | null;
  pushed_at: string | null;
  updated_at: string | null;
  owner: { login: string };
};

// Pull every repository the connected GitHub account can see and upsert it into
// github_repos. Mirrors backfillLinearProjects: GitHub has no webhook that emits
// the full repo list, so this is how the dashboard gets a complete view.
// Paginates /user/repos first, then explicitly enumerates org repos — the
// /user/repos endpoint misses org repos when the org has third-party OAuth app
// restrictions, so the org-level pass acts as a fallback (best-effort per org).
export async function backfillGithubRepos(
  env: Env,
  userId: string,
): Promise<{ synced: number; reason?: string }> {
  // Prefer a configured PAT (sees ALL repos) over the GitHub App OAuth token
  // (limited to installed repos). The PAT makes repo sync work even before the
  // user connects GitHub via OAuth.
  const token = env.GITHUB_PAT || (await getDecryptedToken(env, userId, "github"));
  if (!token) {
    return { synced: 0, reason: "Set GITHUB_PAT or connect GitHub" };
  }

  const ghHeaders = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "fly-dev",
    "x-github-api-version": "2022-11-28",
  };
  const perPage = 100;
  let synced = 0;

  // Pass 1: /user/repos — personal + collaborator + org repos the OAuth app can see.
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      { headers: ghHeaders },
    );
    if (!response.ok) {
      return { synced, reason: `GitHub API returned ${response.status}` };
    }
    const repos = (await response.json()) as GithubRepoNode[];
    if (!Array.isArray(repos) || repos.length === 0) break;
    for (const repo of repos) {
      await upsertGithubRepo(env, userId, repo);
      synced += 1;
    }
    if (repos.length < perPage) break;
  }

  // Pass 2: /user/orgs → /orgs/{org}/repos — catches repos in orgs that have
  // third-party OAuth restrictions (the /user/repos endpoint silently skips them).
  // Best-effort: skip orgs that return non-200 (restriction not approved for this app).
  const orgsResponse = await fetch(
    `https://api.github.com/user/orgs?per_page=100`,
    { headers: ghHeaders },
  ).catch(() => null);
  if (orgsResponse?.ok) {
    const orgs = (await orgsResponse.json()) as Array<{ login: string }>;
    for (const org of orgs) {
      for (let page = 1; page <= 10; page += 1) {
        const orgResp = await fetch(
          `https://api.github.com/orgs/${org.login}/repos?per_page=${perPage}&page=${page}&sort=pushed&type=all`,
          { headers: ghHeaders },
        ).catch(() => null);
        if (!orgResp?.ok) break; // org has restrictions or access denied — skip
        const orgRepos = (await orgResp.json()) as GithubRepoNode[];
        if (!Array.isArray(orgRepos) || orgRepos.length === 0) break;
        for (const repo of orgRepos) {
          await upsertGithubRepo(env, userId, repo);
          synced += 1;
        }
        if (orgRepos.length < perPage) break;
      }
    }
  }

  // Re-run name-based mapping now that the repo list is fresh. Best-effort.
  await autoMapProjects(env, userId).catch(() => undefined);

  return { synced };
}

async function upsertGithubRepo(env: Env, userId: string, repo: GithubRepoNode): Promise<void> {
  await runSql(
    env,
    `INSERT INTO github_repos
       (id, user_id, github_id, owner, name, full_name, url, description, private, fork, archived, default_branch, open_issues, stars, language, pushed_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, github_id) DO UPDATE SET
       owner = excluded.owner,
       name = excluded.name,
       full_name = excluded.full_name,
       url = excluded.url,
       description = excluded.description,
       private = excluded.private,
       fork = excluded.fork,
       archived = excluded.archived,
       default_branch = excluded.default_branch,
       open_issues = excluded.open_issues,
       stars = excluded.stars,
       language = excluded.language,
       pushed_at = excluded.pushed_at,
       updated_at = excluded.updated_at,
       synced_at = CURRENT_TIMESTAMP`,
    [
      `gh_${repo.id}`,
      userId,
      repo.id,
      repo.owner?.login ?? "",
      repo.name,
      repo.full_name,
      repo.html_url,
      repo.description,
      repo.private ? 1 : 0,
      repo.fork ? 1 : 0,
      repo.archived ? 1 : 0,
      repo.default_branch,
      repo.open_issues_count ?? 0,
      repo.stargazers_count ?? 0,
      repo.language,
      repo.pushed_at,
      repo.updated_at,
    ],
  );
}

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priority: number;
  assignee: string | null;
  updatedAt: string | null;
};

// Live-fetch the OPEN issues for a single Linear project (state types backlog /
// unstarted / started — i.e. excluding completed and canceled). Nothing is
// stored; the dashboard calls this when a project row is expanded.
export async function getLinearProjectIssues(
  env: Env,
  userId: string,
  projectId: string,
): Promise<{ issues: LinearIssue[]; reason?: string }> {
  const token = await getDecryptedToken(env, userId, "linear");
  if (!token) {
    return { issues: [], reason: "Linear is not connected" };
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query ProjectIssues($id: String!) {
        project(id: $id) {
          issues(
            first: 100
            filter: { state: { type: { nin: ["completed", "canceled"] } } }
            orderBy: updatedAt
          ) {
            nodes {
              id
              identifier
              title
              url
              priority
              updatedAt
              state { name type }
              assignee { displayName }
            }
          }
        }
      }`,
      variables: { id: projectId },
    }),
  });

  const json = (await response.json()) as {
    data?: {
      project?: {
        issues?: {
          nodes?: Array<{
            id: string;
            identifier: string;
            title: string;
            url: string;
            priority: number | null;
            updatedAt: string | null;
            state?: { name?: string; type?: string } | null;
            assignee?: { displayName?: string } | null;
          }>;
        };
      };
    };
  };

  const nodes = json.data?.project?.issues?.nodes ?? [];
  const issues: LinearIssue[] = nodes.map((node) => ({
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state?.name ?? "Unknown",
    stateType: node.state?.type ?? "unknown",
    priority: node.priority ?? 0,
    assignee: node.assignee?.displayName ?? null,
    updatedAt: node.updatedAt ?? null,
  }));

  return { issues };
}

// --- Linear project <-> GitHub repo mapping --------------------------------

async function loadUserRepos(env: Env, userId: string): Promise<RepoLike[]> {
  return all<RepoLike & Record<string, unknown>>(
    env,
    `SELECT owner, name, full_name AS fullName, url, archived, fork, pushed_at AS pushedAt
     FROM github_repos
     WHERE user_id = ?`,
    [userId],
  );
}

async function writeMapping(
  env: Env,
  projectId: string,
  repo: RepoLike,
  confidence: number,
  source: "auto" | "manual",
  status: "active" | "suggested",
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO repository_mappings
       (id, linear_project_id, provider, owner, repo, url, confidence, source, status)
     VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?)`,
    [id("repo"), projectId, repo.owner, repo.name, repo.url, confidence, source, status],
  );
}

async function setProjectMappingStatus(
  env: Env,
  projectId: string,
  status: "mapped" | "needs_review" | "unmapped",
  confidence: number,
): Promise<void> {
  await runSql(
    env,
    `UPDATE linear_projects SET repo_mapping_status = ?, repo_confidence = ? WHERE id = ?`,
    [status, confidence, projectId],
  );
}

// Auto-map every Linear project to a GitHub repo by name. Confident (exact slug)
// matches become the active mapping; weaker matches are stored as 'suggested'
// (surfaced for one-click confirmation); no match leaves the project unmapped.
// Manual mappings are never overwritten. Idempotent: re-running recomputes all
// non-manual mappings from the current repo list.
export async function autoMapProjects(
  env: Env,
  userId: string,
): Promise<{ mapped: number; needsReview: number; unmapped: number; reason?: string }> {
  const repos = await loadUserRepos(env, userId);
  if (repos.length === 0) {
    return { mapped: 0, needsReview: 0, unmapped: 0, reason: "No GitHub repos synced — Sync GitHub first" };
  }

  const projects = await all<{ id: string; name: string }>(
    env,
    `SELECT id, name FROM linear_projects`,
  );

  let mapped = 0;
  let needsReview = 0;
  let unmapped = 0;

  for (const project of projects) {
    const manual = await first<{ id: string }>(
      env,
      `SELECT id FROM repository_mappings
       WHERE linear_project_id = ? AND source = 'manual' AND status = 'active'
       LIMIT 1`,
      [project.id],
    );
    if (manual) {
      mapped += 1;
      continue;
    }

    // Recompute non-manual mappings from scratch so stale suggestions don't pile up.
    await runSql(
      env,
      `DELETE FROM repository_mappings WHERE linear_project_id = ? AND source != 'manual'`,
      [project.id],
    );

    const match = matchProjectToRepo(project.name, repos);
    if (match.status === "mapped") {
      await writeMapping(env, project.id, match.repo, match.confidence, "auto", "active");
      await setProjectMappingStatus(env, project.id, "mapped", match.confidence);
      mapped += 1;
    } else if (match.status === "needs_review") {
      await writeMapping(env, project.id, match.repo, match.confidence, "auto", "suggested");
      await setProjectMappingStatus(env, project.id, "needs_review", match.confidence);
      needsReview += 1;
    } else {
      await setProjectMappingStatus(env, project.id, "unmapped", 0);
      unmapped += 1;
    }
  }

  return { mapped, needsReview, unmapped };
}

// Manually set a project's repo from a synced github_repos id. Replaces any
// existing mapping with an active, source='manual' one (protected from auto-map).
export async function setProjectMapping(
  env: Env,
  userId: string,
  projectId: string,
  repoId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const repo = await first<RepoLike & Record<string, unknown>>(
    env,
    `SELECT owner, name, full_name AS fullName, url FROM github_repos WHERE id = ? AND user_id = ?`,
    [repoId, userId],
  );
  if (!repo) {
    return { ok: false, reason: "Repository not found" };
  }
  await runSql(env, `DELETE FROM repository_mappings WHERE linear_project_id = ?`, [projectId]);
  await writeMapping(env, projectId, repo, 1, "manual", "active");
  await setProjectMappingStatus(env, projectId, "mapped", 1);
  return { ok: true };
}

export async function clearProjectMapping(
  env: Env,
  projectId: string,
): Promise<{ ok: boolean }> {
  await runSql(env, `DELETE FROM repository_mappings WHERE linear_project_id = ?`, [projectId]);
  await setProjectMappingStatus(env, projectId, "unmapped", 0);
  return { ok: true };
}
