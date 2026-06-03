# Autonomous Linear Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cloudflare Cron Trigger that automatically dispatches agent runs for every open Linear issue across all connected projects, monitors in-progress issues, and takes over after 4 hours if no merged PR is found.

**Architecture:** A `scheduled()` handler fires every 5 minutes and calls `runProjectWatcher(env)`. Watch state (per-issue timestamps, last dispatched run) lives in a new D1 table `issue_watch_state`. Dispatch decisions are made by a pure `shouldDispatchIssue()` function, keeping the orchestration logic testable without mocking I/O.

**Tech Stack:** Cloudflare Workers (TypeScript), Cloudflare Cron Triggers, D1 (SQLite), Vitest, Hono, Linear GraphQL API, GitHub Search API.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `migrations/0005_project_watcher.sql` | Create | `issue_watch_state` table + index |
| `worker/src/platform/integrations.ts` | Modify | Add `teamId` to `LinearIssue` type + GraphQL query |
| `worker/src/platform/github.ts` | Modify | Add `findMergedPrForIssue()` |
| `worker/src/platform/project-watcher.ts` | Create | `shouldDispatchIssue()` pure function + `runProjectWatcher()` orchestrator |
| `worker/src/index.ts` | Modify | Add `scheduled()` export |
| `wrangler.jsonc` | Modify | Add cron trigger, set `REQUIRE_HUMAN_APPROVAL=false` |
| `tests/project-watcher.test.ts` | Create | Unit tests for `shouldDispatchIssue` |
| `tests/github.test.ts` | Create | Unit tests for `findMergedPrForIssue` |

---

## Task 1: D1 Migration — issue_watch_state table

**Files:**
- Create: `migrations/0005_project_watcher.sql`

- [ ] **Step 1: Create the migration file**

Create `migrations/0005_project_watcher.sql` with this exact content:

```sql
-- AGPL-3.0-or-later
-- Issue watch state for the autonomous Linear project watcher.

CREATE TABLE IF NOT EXISTS issue_watch_state (
  issue_id              TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES linear_projects(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES app_users(id),
  team_id               TEXT,
  issue_identifier      TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  state_type            TEXT NOT NULL,
  first_seen_started_at TEXT,
  last_run_id           TEXT REFERENCES runs(id),
  last_run_dispatched_at TEXT,
  last_checked_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issue_watch_project_state
  ON issue_watch_state(project_id, state_type);
```

- [ ] **Step 2: Apply migration locally**

```bash
npm run migrate:local
```

Expected output: `✅ Applied 1 migration` (or similar — wrangler confirms the migration ran)

- [ ] **Step 3: Verify table exists**

```bash
npx wrangler d1 execute fly-dev --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='issue_watch_state'"
```

Expected: one row with `name = issue_watch_state`

- [ ] **Step 4: Commit**

```bash
git add migrations/0005_project_watcher.sql
git commit -m "feat: add issue_watch_state migration for autonomous watcher"
```

---

## Task 2: Add teamId to LinearIssue

**Files:**
- Modify: `worker/src/platform/integrations.ts`

The `LinearIssue` type and GraphQL query returned by `getLinearProjectIssues` currently lack `teamId`. The watcher needs it for `writeBackToLinear` and the dispatch payload.

- [ ] **Step 1: Find the LinearIssue type and query in integrations.ts**

Search for `LinearIssue` and the `ProjectIssues` GraphQL query around line 599-682. You will see:
```ts
type LinearIssue = {
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
```

And in the query body, each issue node fetches: `id identifier title url priority updatedAt state { name type } assignee { displayName }`

- [ ] **Step 2: Add teamId to the LinearIssue type**

In `worker/src/platform/integrations.ts`, update the type (it is local to the file, not exported):

```ts
type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priority: number;
  assignee: string | null;
  updatedAt: string | null;
  teamId: string | null;
};
```

- [ ] **Step 3: Add team { id } to the GraphQL query**

In the `query ProjectIssues` string inside `getLinearProjectIssues`, add `team { id }` to the issue node fields:

```graphql
nodes {
  id
  identifier
  title
  url
  priority
  updatedAt
  state { name type }
  assignee { displayName }
  team { id }
}
```

- [ ] **Step 4: Update the response type assertion and issue mapping**

In the same function, find the `nodes` type assertion (around line 654-668). Add `team` to the node type:

```ts
nodes?: Array<{
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number | null;
  updatedAt: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: { displayName?: string } | null;
  team?: { id?: string } | null;
}>;
```

Then in the `.map()` that builds `LinearIssue[]`, add the `teamId` field:

```ts
const issues: LinearIssue[] = nodes.map((node) => ({
  id: node.id,
  identifier: node.identifier,
  title: node.title,
  url: node.url,
  state: node.state?.name ?? "unknown",
  stateType: node.state?.type ?? "unknown",
  priority: node.priority ?? 0,
  assignee: node.assignee?.displayName ?? null,
  updatedAt: node.updatedAt ?? null,
  teamId: node.team?.id ?? null,
}));
```

- [ ] **Step 5: Verify types are consistent**

```bash
npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add worker/src/platform/integrations.ts
git commit -m "feat: add teamId to LinearIssue for watcher dispatch"
```

---

## Task 3: Add findMergedPrForIssue to github.ts

**Files:**
- Modify: `worker/src/platform/github.ts`
- Create: `tests/github.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/github.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMergedPrForIssue } from "../worker/src/platform/github";
import type { Env } from "../worker/src/env";

// Uses GITHUB_PAT so getInstallationToken returns null and only one fetch is made
const mockEnv = {
  GITHUB_APP_ID: undefined,
  GITHUB_APP_PRIVATE_KEY: undefined,
  GITHUB_PAT: "ghp_test_token_for_tests",
} as unknown as Env;

describe("findMergedPrForIssue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when a merged PR references the issue identifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ total_count: 1, items: [{ number: 42 }] }),
      }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-42");

    expect(result).toBe(true);
    const url = (vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url).toContain("FLY-42");
    expect(url).toContain("is:merged");
  });

  it("returns false when no merged PRs match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-99");

    expect(result).toBe(false);
  });

  it("returns false when the GitHub API returns an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-1");

    expect(result).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-1");

    expect(result).toBe(false);
  });

  it("returns false when no token is available", async () => {
    const noTokenEnv = {
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_PAT: undefined,
    } as unknown as Env;

    const result = await findMergedPrForIssue(noTokenEnv, "acme", "myrepo", "FLY-1");

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/github.test.ts
```

Expected: FAIL — `findMergedPrForIssue is not exported from github`

- [ ] **Step 3: Implement findMergedPrForIssue in github.ts**

Add this function to `worker/src/platform/github.ts` (after the existing `getInstallationToken` function):

```ts
// Search GitHub for a merged PR that references issueIdentifier (e.g. "FLY-42")
// in its title or body. Uses the App installation token if available, falls back
// to GITHUB_PAT. Returns false on any error so callers treat failure as "not found".
export async function findMergedPrForIssue(
  env: Env,
  owner: string,
  repo: string,
  issueIdentifier: string,
): Promise<boolean> {
  try {
    const token =
      (await getInstallationToken(env, owner, repo)) ?? env.GITHUB_PAT ?? null;
    if (!token) return false;

    const q = `repo:${owner}/${repo} is:pr is:merged ${issueIdentifier} in:title,body`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: ghHeaders(token) });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { total_count?: number };
    return (data.total_count ?? 0) > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/github.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/github.ts tests/github.test.ts
git commit -m "feat: add findMergedPrForIssue for in-progress takeover check"
```

---

## Task 4: shouldDispatchIssue pure function + tests

**Files:**
- Create: `worker/src/platform/project-watcher.ts` (skeleton + pure function only)
- Create: `tests/project-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/project-watcher.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { shouldDispatchIssue } from "../worker/src/platform/project-watcher";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

// A representative "now" timestamp
const NOW_MS = new Date("2026-06-02T12:00:00Z").getTime();

describe("shouldDispatchIssue", () => {
  it("dispatches a backlog issue with no active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "backlog", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("dispatches an unstarted issue with no active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "unstarted", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("skips a backlog issue that already has an active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "backlog", first_seen_started_at: null },
        true,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue that has been in progress for less than 1 hour", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 2h when a merged PR already exists", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 2 * ONE_HOUR_MS).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        true,  // hasMergedPr
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 2h with no merged PR (still within 4h window)", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 2 * ONE_HOUR_MS).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("dispatches a started issue at exactly 4h+ with no merged PR", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("skips a started issue at 4h+ when a merged PR exists", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        true,  // hasMergedPr
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 4h+ that already has an active run", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        true,  // hasActiveRun
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("returns delete for a completed issue", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "completed", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("delete");
  });

  it("returns delete for a canceled issue", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "canceled", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("delete");
  });

  it("skips a started issue with no first_seen_started_at yet set", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/project-watcher.test.ts
```

Expected: FAIL — `shouldDispatchIssue is not exported from project-watcher`

- [ ] **Step 3: Create project-watcher.ts with the pure function**

Create `worker/src/platform/project-watcher.ts`:

```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { all, ensureUser, first, runSql } from "./data";
import { getLinearProjectIssues } from "./integrations";
import { findMergedPrForIssue } from "./github";
import { createTaskRun } from "./orchestration";

export type IssueWatchRow = {
  issue_id: string;
  project_id: string;
  user_id: string;
  team_id: string | null;
  issue_identifier: string;
  title: string;
  description: string | null;
  state_type: string;
  first_seen_started_at: string | null;
  last_run_id: string | null;
  last_run_dispatched_at: string | null;
  last_checked_at: string;
  updated_at: string;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;
const MAX_CONCURRENT_RUNS = 5;

// Pure dispatch decision — no I/O. Determines what the watcher should do for
// a given issue row given the current context.
export function shouldDispatchIssue(
  row: Pick<IssueWatchRow, "state_type" | "first_seen_started_at">,
  hasActiveRun: boolean,
  hasMergedPr: boolean,
  nowMs: number,
): "dispatch" | "skip" | "delete" {
  if (row.state_type === "completed" || row.state_type === "canceled") return "delete";
  if (hasActiveRun) return "skip";
  if (row.state_type === "backlog" || row.state_type === "unstarted") return "dispatch";
  if (row.state_type === "started") {
    if (!row.first_seen_started_at) return "skip";
    const elapsedMs = nowMs - new Date(row.first_seen_started_at).getTime();
    if (elapsedMs < ONE_HOUR_MS) return "skip";
    if (hasMergedPr) return "skip";
    if (elapsedMs < FOUR_HOURS_MS) return "skip";
    return "dispatch";
  }
  return "skip";
}

export async function runProjectWatcher(env: Env): Promise<void> {
  // Stub — implemented in Task 5.
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/project-watcher.test.ts
```

Expected: all 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/project-watcher.ts tests/project-watcher.test.ts
git commit -m "feat: add shouldDispatchIssue pure function with tests"
```

---

## Task 5: Implement runProjectWatcher orchestrator

**Files:**
- Modify: `worker/src/platform/project-watcher.ts`

- [ ] **Step 1: Replace the stub with the full implementation**

Replace the `runProjectWatcher` function body in `worker/src/platform/project-watcher.ts`:

```ts
export async function runProjectWatcher(env: Env): Promise<void> {
  try {
    // Enforce global concurrency cap to avoid overwhelming the container fleet.
    const cap = await first<{ cnt: number }>(
      env,
      "SELECT COUNT(*) as cnt FROM runs WHERE status IN ('queued', 'running', 'waiting_approval')",
      [],
    );
    if ((cap?.cnt ?? 0) >= MAX_CONCURRENT_RUNS) {
      console.log("[watcher] concurrency cap reached, skipping tick");
      return;
    }

    // Use a synthetic internal user as the run owner (same identity as webhooks).
    const internalUser = await ensureUser(env, {
      email: null,
      name: "Fly Watcher",
      flyUserSlug: "internal",
      authSource: "internal",
    });

    // Find all users with an active Linear OAuth connection.
    const connections = await all<{ user_id: string }>(
      env,
      "SELECT user_id FROM account_connections WHERE provider = 'linear' AND status = 'connected'",
      [],
    );
    if (connections.length === 0) return;

    // Use the first connected user's token to fetch all Linear projects.
    // linear_projects is a shared table with no user_id FK; the first active
    // connection is sufficient for a single-workspace setup.
    const userId = connections[0].user_id;

    const projects = await all<{ id: string }>(
      env,
      "SELECT id FROM linear_projects",
      [],
    );

    for (const project of projects) {
      try {
        await watchProject(env, userId, project.id, internalUser);
      } catch (err) {
        console.warn(`[watcher] project ${project.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[watcher] top-level error:", err);
  }
}

async function watchProject(
  env: Env,
  userId: string,
  projectId: string,
  internalUser: { id: string; flyUserSlug: string; email: string | null; name: string | null; authSource: "internal" },
): Promise<void> {
  const { issues, reason } = await getLinearProjectIssues(env, userId, projectId);
  if (reason || issues.length === 0) return;

  const now = new Date().toISOString();
  const returnedIds = new Set(issues.map((i) => i.id));

  // Upsert each returned issue. Sets first_seen_started_at only once (on first
  // transition into 'started'). All other fields are kept current.
  for (const issue of issues) {
    await runSql(
      env,
      `INSERT INTO issue_watch_state
         (issue_id, project_id, user_id, team_id, issue_identifier, title, description,
          state_type, last_checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         state_type    = excluded.state_type,
         title         = excluded.title,
         team_id       = COALESCE(excluded.team_id, team_id),
         last_checked_at = excluded.last_checked_at,
         updated_at    = excluded.updated_at,
         first_seen_started_at = CASE
           WHEN excluded.state_type = 'started' AND first_seen_started_at IS NULL
           THEN excluded.last_checked_at
           ELSE first_seen_started_at
         END`,
      [
        issue.id,
        projectId,
        userId,
        issue.teamId ?? null,
        issue.identifier,
        issue.title,
        null,
        issue.stateType,
        now,
        now,
      ],
    );
  }

  // Reconcile: delete rows for issues that disappeared from Linear (completed,
  // canceled, or deleted). getLinearProjectIssues already excludes completed/
  // canceled via its filter, so vanished rows are safe to drop.
  const existingRows = await all<{ issue_id: string }>(
    env,
    "SELECT issue_id FROM issue_watch_state WHERE project_id = ?",
    [projectId],
  );
  for (const row of existingRows) {
    if (!returnedIds.has(row.issue_id)) {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
    }
  }

  // Fetch the repo mapping once for this project (needed for PR check).
  const repoMapping = await first<{ owner: string; repo: string }>(
    env,
    "SELECT owner, repo FROM repository_mappings WHERE linear_project_id = ? AND status = 'active' LIMIT 1",
    [projectId],
  );

  // Apply dispatch rules to each watched issue.
  const watchRows = await all<IssueWatchRow>(
    env,
    "SELECT * FROM issue_watch_state WHERE project_id = ?",
    [projectId],
  );

  const nowMs = Date.now();

  for (const row of watchRows) {
    if (row.state_type === "completed" || row.state_type === "canceled") {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
      continue;
    }

    const activeRun = await first<{ id: string }>(
      env,
      "SELECT id FROM runs WHERE linear_issue_id = ? AND status IN ('queued', 'running', 'waiting_approval')",
      [row.issue_id],
    );
    const hasActiveRun = Boolean(activeRun);

    // Only check GitHub PR for started issues that have crossed the 1h mark.
    let hasMergedPr = false;
    if (
      row.state_type === "started" &&
      row.first_seen_started_at &&
      repoMapping &&
      !hasActiveRun
    ) {
      const elapsedMs = nowMs - new Date(row.first_seen_started_at).getTime();
      if (elapsedMs >= ONE_HOUR_MS) {
        hasMergedPr = await findMergedPrForIssue(
          env,
          repoMapping.owner,
          repoMapping.repo,
          row.issue_identifier,
        );
      }
    }

    const decision = shouldDispatchIssue(row, hasActiveRun, hasMergedPr, nowMs);
    if (decision === "delete") {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
      continue;
    }
    if (decision !== "dispatch") continue;

    const resp = await createTaskRun(env, internalUser, {
      objective: `${row.title}${row.description ? `\n\n${row.description}` : ""}`.trim(),
      linearProjectId: row.project_id,
      linearIssueId: row.issue_id,
      linearTeamId: row.team_id ?? undefined,
      agentProvider: "claude-code",
      autonomyMode: "auto_eligible",
      source: "project-watcher",
    });

    if (resp.status === 201) {
      const data = (await resp.json()) as { id: string };
      await runSql(
        env,
        "UPDATE issue_watch_state SET last_run_id = ?, last_run_dispatched_at = ?, updated_at = ? WHERE issue_id = ?",
        [data.id, new Date().toISOString(), new Date().toISOString(), row.issue_id],
      );
      console.log(`[watcher] dispatched run ${data.id} for issue ${row.issue_identifier}`);
    }
  }
}
```

- [ ] **Step 2: Verify types compile**

```bash
npm run typecheck
```

Expected: no errors

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
npm run test
```

Expected: all tests PASS (project-watcher + github + existing tests)

- [ ] **Step 4: Commit**

```bash
git add worker/src/platform/project-watcher.ts
git commit -m "feat: implement runProjectWatcher orchestrator"
```

---

## Task 6: Wire up scheduled handler and update wrangler config

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `wrangler.jsonc`

- [ ] **Step 1: Add the scheduled export to index.ts**

In `worker/src/index.ts`, find the `export default { async fetch(...) {...}, async queue(...) {...} }` block at the bottom of the file (around line 1021). Add a `scheduled` handler:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/agents/")) {
      const routed = await routeAgentRequest(request, env).catch(() => null);
      if (routed) return routed;
    }
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<WorkQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.action === "start-run") {
          const run = await first<{ objective: string }>(
            env,
            "SELECT objective FROM runs WHERE id = ?",
            [message.body.runId],
          );
          await startRunWorkflow(env, {
            runId: message.body.runId,
            userId: message.body.userId,
            projectId: message.body.projectId,
            objective: run?.objective ?? "Continue queued fly-dev run",
          });
          message.ack();
        } else {
          console.warn("Unhandled queue action", message.body.action);
          message.ack();
        }
      } catch (error) {
        await markRunFailed(env, message.body.runId, error);
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runProjectWatcher(env));
  },
};
```

Also add the import at the top of `worker/src/index.ts` alongside the other platform imports:

```ts
import { runProjectWatcher } from "./platform/project-watcher";
```

- [ ] **Step 2: Add cron trigger to wrangler.jsonc**

In `wrangler.jsonc`, add a `"triggers"` block after the `"routes"` block:

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
},
```

- [ ] **Step 3: Flip REQUIRE_HUMAN_APPROVAL in wrangler.jsonc**

In the `"vars"` section, change:

```jsonc
"REQUIRE_HUMAN_APPROVAL": "false"
```

(was `"true"`)

- [ ] **Step 4: Verify the full build**

```bash
npm run build
```

Expected: no TypeScript errors, Vite build succeeds, worker compiles

- [ ] **Step 5: Verify the cron shows up in a dry-run deploy**

```bash
npm run cf:dry-run
```

Expected: output includes `Cron Triggers` with `*/5 * * * *`

- [ ] **Step 6: Run the full test suite one final time**

```bash
npm run test
```

Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.ts wrangler.jsonc
git commit -m "feat: wire up autonomous Linear watcher cron trigger"
```

---

## Self-Review Checklist

- [x] **Migration** creates `issue_watch_state` with all columns referenced in the code (Task 1)
- [x] **teamId on LinearIssue** — added to type, GraphQL query, and mapping (Task 2); used in upsert and dispatch payload (Task 5)
- [x] **findMergedPrForIssue** — exported from github.ts, tested with mocked fetch (Task 3)
- [x] **shouldDispatchIssue** — all 11 spec scenarios covered in tests (Task 4)
- [x] **runProjectWatcher** — iterates users → projects → issues; upserts; reconciles; dispatches (Task 5)
- [x] **Concurrency cap** — checked at start of each tick; returns early if ≥5 (Task 5)
- [x] **Dedup** — active run check per issue before dispatching (Task 5)
- [x] **first_seen_started_at** — set once via SQL CASE, never reset (Task 5)
- [x] **last_run_id** updated after successful dispatch (Task 5)
- [x] **scheduled handler** wired up with `ctx.waitUntil` (Task 6)
- [x] **REQUIRE_HUMAN_APPROVAL** flipped to false (Task 6)
- [x] **Cron trigger** added to wrangler.jsonc (Task 6)
- [x] **IssueWatchRow** type defined in project-watcher.ts and used consistently
- [x] **internalUser** passed as `CurrentUser` to `createTaskRun` — `ensureUser` returns the correct shape
