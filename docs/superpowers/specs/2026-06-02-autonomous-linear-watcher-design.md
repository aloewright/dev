# Autonomous Linear Project Watcher

**Date:** 2026-06-02  
**Status:** Approved for implementation  
**Scope:** `fly-dev` (dev.fly.pm) Worker + D1

---

## Overview

The autonomous Linear watcher is a Cloudflare Cron Trigger that fires every 5 minutes and scans all connected Linear projects for actionable issues. Issues in Backlog or To Do are dispatched to the agent pipeline immediately. Issues already In Progress are monitored: after 1 hour, the watcher checks GitHub for a merged PR; if none is found after 4 hours total, the watcher takes over and dispatches a run to finish or fix the issue. All runs fire without human approval.

---

## Architecture

### Mechanism: Cron Trigger + D1 state

A `scheduled()` handler is added to the Worker's default export. Cloudflare fires it every 5 minutes (`*/5 * * * *`). The handler calls `runProjectWatcher(env)` inside `ctx.waitUntil()` so it doesn't block the cron response.

All watch state lives in D1 (`issue_watch_state` table). This keeps it queryable, survives Worker restarts, and sets up future dashboard visibility.

No new Durable Objects. The existing `"internal"` user identity (same as webhook dispatch) is used as `user_id` for all watcher-created runs.

### Why not Durable Object alarms

`ProjectConductor` DOs exist per-project but require activation per-instance to set alarms. A single global cron handler is simpler, puts the authoritative watch state in one queryable place, and naturally enforces the cross-project concurrency cap.

---

## Data Model

### New table: `issue_watch_state`

```sql
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

**Fields:**
- `issue_id` — Linear issue ID (primary key; stable across renames)
- `user_id` — The app user whose Linear OAuth token is used to fetch this issue. Required because `getLinearProjectIssues` looks up the token by user.
- `team_id` — Linear team UUID, populated from the issue's `team.id` field in the GraphQL response. Stored here because `linear_projects` only has `team_key` (slug), not the UUID required by `issueUpdate` mutations.
- `issue_identifier` — Human-readable identifier e.g. `FLY-42`, used for GitHub PR search
- `state_type` — Linear workflow state type: `backlog`, `unstarted`, `started`, `completed`, `canceled`
- `first_seen_started_at` — Timestamp when the issue first entered `started` state. Set once; never reset. Drives the 1h check and 4h takeover clock.
- `last_run_id` — The most recently dispatched run for this issue. Dedup key.
- `last_run_dispatched_at` — When the last run was dispatched. Used to avoid re-dispatching for the same state transition in rapid succession.

### Migration

`migrations/0005_project_watcher.sql` — creates the table and index.

---

## Dispatch Rules

Each cron tick applies these rules to every open issue returned by `getLinearProjectIssues()` across all connected projects:

| State type | Rule |
|---|---|
| `backlog` or `unstarted` | Dispatch a run immediately if no active run exists for this issue |
| `started` | Set `first_seen_started_at` if not already set. At ≥1h: check GitHub for a merged PR referencing `issue_identifier`. At ≥4h with no merged PR found: dispatch a run to finish/fix. |
| `completed` or `canceled` | Delete row from `issue_watch_state` (stop watching) |

**Active run definition:** a run row with `linear_issue_id = ?` and `status IN ('queued', 'running', 'waiting_approval')`.

**Concurrency cap:** maximum 5 concurrent active runs across all projects (matches `max_instances: 5` on the `SandboxContainer`). If the cap is hit, eligible issues are deferred to the next tick. The cap count is a single `SELECT COUNT(*)` against `runs` at the start of each tick.

**Dispatch payload:**
```ts
{
  objective: `${row.title}\n\n${row.description ?? ""}`.trim(),
  linearProjectId: row.project_id,
  linearIssueId: row.issue_id,
  linearTeamId: row.team_id ?? undefined,
  agentProvider: "claude-code",
  autonomyMode: "auto_eligible",
  source: "project-watcher",
}
```
All values come from `issue_watch_state` columns, not the transient `LinearIssue` object.

`autonomyMode: "auto_eligible"` bypasses the approval gate. `REQUIRE_HUMAN_APPROVAL` in `wrangler.jsonc` is flipped to `"false"` so the global guard is off.

---

## GitHub PR Check

**Function:** `findMergedPrForIssue(env, owner, repo, issueIdentifier): Promise<boolean>`  
**Location:** `worker/src/platform/github.ts`

Uses the GitHub search API:
```
GET /search/issues?q=repo:{owner}/{repo}+is:pr+is:merged+{issueIdentifier}+in:title,body
```

Authenticated with the GitHub App installation token (already obtained via `getInstallationToken()`). Returns `true` if at least one merged PR is found. On API failure, returns `false` (treats as "no PR found"; the 4h clock continues).

The check is only made when `first_seen_started_at` is ≥1 hour ago. It is re-checked on every tick after that point until a PR is found or the 4h takeover fires.

---

## New Files

### `worker/src/platform/project-watcher.ts`

Single exported function `runProjectWatcher(env: Env): Promise<void>`.

Responsibilities in order:
1. Count active runs; if ≥5, log and return early.
2. Query `account_connections` for all users with `provider = 'linear'` and `status = 'connected'`. For each user, fetch their `linear_projects` from D1.
3. For each `(userId, projectId)` pair, call `getLinearProjectIssues(env, userId, projectId)`. The GraphQL query is extended to include `team { id }` on each issue node so `team_id` is available for dispatch and write-back.
4. Upsert each returned issue into `issue_watch_state` (update `state_type`, `title`, `team_id`, `last_checked_at`; set `first_seen_started_at` only when transitioning into `started` for the first time; set `user_id` and `project_id` on insert).
5. Delete `issue_watch_state` rows for issues no longer returned (completed, canceled, or deleted in Linear).
6. For each actionable row in `issue_watch_state`, apply dispatch rules. Call `createTaskRun()` for eligible issues; update `last_run_id` and `last_run_dispatched_at` on success.

### `migrations/0005_project_watcher.sql`

Creates `issue_watch_state` and its index.

---

## Modified Files

### `worker/src/index.ts`

Add `scheduled` to the default export:
```ts
async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runProjectWatcher(env));
},
```

### `worker/src/platform/github.ts`

Add `findMergedPrForIssue()`.

### `worker/src/platform/integrations.ts`

Extend the `getLinearProjectIssues` GraphQL query to include `team { id }` on each issue node, and add `teamId: string | null` to the returned `LinearIssue` type.

### `wrangler.jsonc`

```jsonc
"triggers": { "crons": ["*/5 * * * *"] },
// vars:
"REQUIRE_HUMAN_APPROVAL": "false"
```

---

## Error Handling

| Failure | Behavior |
|---|---|
| Linear API error for a project | Log warning, skip that project, continue with others |
| GitHub PR check error | Treat as `false` (no PR found). Do not reset `first_seen_started_at`. |
| `createTaskRun` error | Log error, skip that issue. Retried on next tick (dedup will see no active run). |
| Concurrency cap reached | Log count of deferred issues. No state change; re-evaluated next tick. |
| Issue deleted in Linear | Not returned by `getLinearProjectIssues`; watcher deletes its row on next reconciliation pass. |
| No Linear token for a project's owner | `getLinearProjectIssues` returns `{issues: [], reason: "..."}`. Project is skipped silently. |

All errors in `runProjectWatcher` are caught at the top level and logged. A single project's failure never aborts the full tick.

---

## Testing

**File:** `tests/project-watcher.test.ts`

Unit tests using mock `env` and stubbed `createTaskRun` / `getLinearProjectIssues` / `findMergedPrForIssue`:

| Scenario | Expected |
|---|---|
| Issue in `backlog`, no active run | `createTaskRun` called once |
| Issue in `unstarted`, no active run | `createTaskRun` called once |
| Issue in `started`, < 1h elapsed | No dispatch |
| Issue in `started`, ≥ 1h, merged PR found | No dispatch |
| Issue in `started`, ≥ 4h, no merged PR | `createTaskRun` called once |
| Issue in `started`, active run exists | No dispatch (dedup) |
| Issue moves to `completed` | Row deleted from `issue_watch_state` |
| Concurrency cap at 5 active runs | No dispatch for any issue |
| Linear API throws | Project skipped; other projects still processed |

---

## Security Notes

- `REQUIRE_HUMAN_APPROVAL=false` disables the global approval gate for ALL runs (dashboard-submitted, webhook-triggered, and watcher-dispatched). This is intentional and matches the "fully autonomous" decision.
- Watcher-dispatched runs use `source: "project-watcher"` for auditability in `runs.metadata_json`.
- Secrets (GitHub token, Linear token, AI gateway token) are resolved inside `RunWorkflow` steps, never stored in `issue_watch_state` or passed through the cron handler.
- The concurrency cap of 5 prevents runaway container spend if a large batch of issues appears simultaneously.
