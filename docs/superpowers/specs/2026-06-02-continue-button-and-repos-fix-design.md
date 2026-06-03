# Design: Autonomous "Continue" + GitHub repos reclaim/harden

Date: 2026-06-02
Status: Approved (pending spec review)

## Summary

Two related pieces of work on `dev.fly.pm`:

1. **GitHub repos fix (Part A)** — repos are synced (275 rows in prod) but do not show
   in the UI because they are scoped to an `app_users.id` that the Wave 1 auth
   migration changed. Reclaim the orphaned data and harden the sync path so it
   self-heals and fails loudly.

2. **Autonomous "Continue" (Part B)** — a per-project button that reviews a Linear
   project, asks an LLM for the best next steps, breaks them into Linear issues,
   and begins execution. Fully autonomous per the operator's choice.

Part A is a **prerequisite** for Part B: `autoMapProjects` reads *user-scoped*
repos, so with the current user at 0 repos no project can map, and runs abort with
`no_repository`.

## Root cause (Part A)

`github_repos` is keyed by `app_users.id`, derived from `fly_user_slug`. The Wave 1
migration (commit `5934cb2`, "remove Cloudflare Access") changed how the slug is
derived (`getCurrentUser` now returns `flyUserSlug: ba-${flyUser.id}`), minting a
**new** `app_users` row for the same human.

Prod evidence:

| user_id | slug | auth_source | email | repos |
|---|---|---|---|---|
| `user_cbc0630b…` | `aloewright` | cf-access (legacy) | aloewright@gmail.com | 274 |
| `user_526c841c…` | `ba-4BXHsOWb…` | fly (current) | aloe@fly.pm | 0 |

`getGithubRepos(env, user.id)` filters `WHERE user_id = ?`, so the current `fly`
user sees 0 repos while 274 sit under the legacy `cf-access` user. `linear_projects`
are unaffected because they are global (no `user_id`). The current `fly` user
*does* already have working github + linear `account_connections`, so OAuth tokens
are not stranded — only repo rows and run/usage history are.

Contributing UX problems:
- The "Sync" button is hidden unless GitHub is OAuth-connected, even though
  `GITHUB_PAT` (which is set) can sync without OAuth.
- `backfillGithubRepos` returns `{ synced, reason }` but the UI swallows `reason`,
  so failed syncs look like no-ops.

## Part A — Reclaim + Harden

### A1. Reclaim (one-time, idempotent)

Add an HMAC-gated internal route (mirrors existing `/api/internal/*`, auth via
`verifyInternalRequest`):

```
POST /api/internal/reclaim
body: { intoUserId: string }
```

Behavior — fold every *other* user's user-scoped rows into `intoUserId`:
- `github_repos`, `runs`, `usage_events`, `agent_memories`:
  `UPDATE … SET user_id = :into WHERE user_id != :into`.
  Safe for `github_repos`: `UNIQUE(user_id, github_id)` won't collide because the
  target user has 0 repos. Idempotent: a second run matches no rows
  (`WHERE user_id != :into` is empty once everything is folded in), so re-running
  is a no-op.
- `account_connections`: do **not** re-point (would violate `UNIQUE(user_id,
  provider)` since the target already has github+linear). Delete the legacy
  duplicates instead.
- Then call `autoMapProjects(env, intoUserId)` so the 26 projects map against the
  now-present repos.

Returns counts: `{ repos, runs, usage, memories, connectionsDropped, mapped }`.

Run once against prod with `intoUserId = user_526c841c1a404bff9278740309b1333f`.

### A2. Harden (code)

1. **Auto-backfill on empty.** In the `/api/overview` route handler, after building
   the overview: if the authed user has 0 repos AND (`env.GITHUB_PAT` set OR github
   connection present), schedule `backfillGithubRepos(env, user.id)` via
   `c.executionCtx.waitUntil(...)`, guarded by a per-user KV flag
   (`CACHE` key `repos-autosync:<userId>`, TTL ~1h) so it runs at most once per
   window and never blocks the response. Repos appear on the next refresh.

2. **Surface sync failures.** Thread `backfillGithubRepos`'s `{ synced, reason }`
   through the `/api/integrations/github/sync` response (already does) and render it
   in the UI: success → "Synced N repos"; `reason` present → red banner with the
   reason.

3. **PAT-aware Sync affordance.** Add a "Sync repos" button to the **GitHub Repos**
   card header (always available when authed), and a real "Sync repos" button in the
   empty state, both calling `POST /api/integrations/github/sync`. This decouples
   sync from OAuth-connected status (endpoint already prefers `GITHUB_PAT`).

No schema changes.

## Part B — Autonomous "Continue"

### B1. UI

- A filled **"Continue ▶"** button inside the expanded `ProjectRow`, near the repo
  mapping controls.
- On click: a single confirm ("This creates Linear issues and starts runs.
  Continue?"), then `POST /api/projects/:id/continue`.
- Progress states: reviewing → drafting plan → creating N issues → starting runs.
- Result panel rendered inline: plan summary, created issues (identifier + title +
  link), and queued run ids. Errors (e.g. unmapped repo) shown clearly with the
  remedy.

### B2. Endpoint `POST /api/projects/:id/continue`

Runs as the current user. Steps:

1. **Review.** Load the `linear_projects` row (name, description, summary, status),
   live open issues via `getLinearProjectIssues`, and the active repo mapping. If
   no active mapping: call `autoMapProjects(env, user.id)` and re-check; if still
   unmapped, return `409 { error, needsRepo: true }`.

2. **Plan.** New `planNextSteps(env, context)` in `worker/src/platform/planner.ts`.
   Calls the sanctioned worker gateway pattern (per `~/.claude/CLAUDE.md`):
   `env.AI.run("@cf/openai/gpt-oss-120b", { messages, max_tokens }, { gateway: { id } })`,
   with a comment pointing back to the CLAUDE.md "Inside a Worker" section so it can
   be swapped to a dynamic route when that's fixed upstream. The prompt requests
   strict JSON:
   ```json
   {
     "summary": "string",
     "issues": [{ "title": "string", "description": "string", "priority": 1-4 }],
     "execute": [0, 1, 2]
   }
   ```
   `issues` capped at 6; `execute` indexes capped at `CONTINUE_EXECUTE_CAP` (3).
   Defensive parse (strip code fences, tolerate `reasoning_content`); on parse
   failure return `502 { error: "planner returned no usable plan" }` without writing
   anything.

3. **Break down.** New `createLinearIssue(token, { teamId, projectId, title,
   description, priority })` and `resolveProjectTeam(token, projectId)` in
   `worker/src/platform/linear.ts` (GraphQL `issueCreate`; team resolved via
   `project(id){ teams(first:1){ nodes { id } } }`). Create each planned issue under
   the project + team. Collect `{ id, identifier, url }`.

4. **Execute (autonomous).** Select which issues to run from the planner's
   `execute` index list (into `issues`), deduped and capped at
   `CONTINUE_EXECUTE_CAP`; if `execute` is missing/empty, fall back to the
   top-priority issues up to the cap. For each selected issue call a new
   `createAutonomousRun(env, user, payload)` in
   `orchestration.ts`: create the run with `autonomyMode: "auto_eligible"`,
   `linearIssueId`, `linearTeamId`, `source: "continue"`, then transition it
   straight to `queued` and enqueue — **bypassing** the `REQUIRE_HUMAN_APPROVAL`
   gate. This bypass is active only when `env.CONTINUE_AUTONOMY === "true"`; when
   off, runs are created `waiting_approval` like any other. Remaining planned issues
   are left for a later Continue/approval.

5. **Record + respond.** Write a `run_events`/`agent_memories` (`memory_type:
   "plan"`) entry capturing the plan. Respond:
   ```json
   {
     "summary": "…",
     "createdIssues": [{ "identifier": "ENG-12", "title": "…", "url": "…" }],
     "queuedRuns": [{ "id": "run_…", "issue": "ENG-12" }],
     "skipped": 3
   }
   ```

### B3. New / changed files

| File | Change |
|---|---|
| `worker/src/platform/planner.ts` | **new** — `planNextSteps()` + shared gateway chat-JSON helper |
| `worker/src/platform/linear.ts` | + `createLinearIssue()`, `resolveProjectTeam()` |
| `worker/src/platform/orchestration.ts` | + `createAutonomousRun()` (create + auto-approve) |
| `worker/src/index.ts` | + `POST /api/projects/:id/continue`, + `POST /api/internal/reclaim`, harden `/api/overview` |
| `src/App.tsx` | Continue button + result panel; GitHub repos Sync affordance + error surfacing |
| `worker/src/env.ts`, `wrangler.jsonc` vars | + `CONTINUE_AUTONOMY` (default "true"), + `CONTINUE_EXECUTE_CAP` (default "3") |

### B4. Error handling

- Unmapped project → `409 { needsRepo: true }`, UI prompts to map a repo.
- Linear not connected / token missing → `400` with reason; no issues created.
- Planner failure (no JSON) → `502`, nothing written.
- `issueCreate` partial failure → return the issues that succeeded; do not start
  runs for failed issues.
- Run creation respects existing secret redaction (`createTaskRun` redacts
  objectives) and concurrency (`SANDBOX_CONTAINER max_instances = 5`).

## Security notes

Fully autonomous mode bypasses the human-approval gate the codebase is built around
(`SANDBOX_REVIEW.md` §C). This is the operator's explicit choice, scoped by:
- The `CONTINUE_AUTONOMY` env flag (off → falls back to approval-gated runs).
- A per-click UI confirm.
- The `CONTINUE_EXECUTE_CAP` run cap + container `max_instances`.
- Existing sandbox egress allowlist already covers `api.linear.app`,
  `api.github.com`, `gateway.ai.cloudflare.com`.

## Testing

- `planner.test.ts` — JSON extraction from fenced / reasoning-laden model output;
  cap enforcement; malformed input → null.
- `linear.test.ts` — `createLinearIssue` / `resolveProjectTeam` request shapes
  (mocked fetch).
- `continue.test.ts` — endpoint flow with mocked Linear + planner: unmapped →
  409; happy path creates issues + queued runs; `CONTINUE_AUTONOMY=false` →
  runs land `waiting_approval`.
- `reclaim.test.ts` — idempotent fold; `account_connections` dedupe; re-run is a
  no-op.
- Existing `npm test` (vitest) + `npm run typecheck` must stay green.

## Build sequence

1. Part A reclaim endpoint + run once against prod (unblocks mapping).
2. Part A harden (auto-backfill, error surfacing, Sync affordance).
3. Part B planner + linear issue creation + autonomous run.
4. Part B endpoint + UI.
5. Tests throughout; typecheck + test gate before merge.
