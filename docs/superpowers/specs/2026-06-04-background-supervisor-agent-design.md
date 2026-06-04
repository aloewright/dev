# Design: Background Supervisor Agent (effectiveness, reports, self-repair)

Date: 2026-06-04
Status: Approved (pending spec review)

## Summary

A persistent **`SupervisorAgent`** (Cloudflare Agents SDK Durable Object, one per fly
user) that watches the autonomous run pipeline, scores its effectiveness, intervenes
when things go wrong — including **executing code in its own sandbox to fix issues
and redeploying** — sends daily/weekly/per-repo **code reports**, and answers the
user's questions in a chat panel. A new **effectiveness dashboard** surfaces all of
it.

Three subsystems, one agent, built in phases:
- **A. Effectiveness dashboard** — metrics + drill-down over a new data hierarchy.
- **B. Code reports** — scheduled digests emailed via a Cloudflare Email binding.
- **C. Supervisor + chat** — watch → score → auto-act+notify → self-repair; chat Q&A.

Tech (per the user's direction): **Cloudflare Agents SDK** (`agents`, already a dep)
for the DO + **Session-API memory** + scheduling; **TanStack AI** (`@tanstack/ai`,
`@tanstack/ai-react`) for the chat UI + tool-calling; all model calls through the
**Cloudflare AI Gateway** (worker-side via the sanctioned `env.AI.run("@cf/…", …,
{ gateway:{id} })` pattern — dynamic routes don't resolve inside a Worker, see
`~/.claude/CLAUDE.md`).

## Data ownership hierarchy

The crux of "effectiveness." Effectiveness scores attach to tasks and roll up:

```
github_repos (repo)                                         existing
└─ objectives        (id, repo_full_name, title, summary, source, status, …)   NEW
   └─ workflows      (id, objective_id, kind, status, started_at, finished_at)  NEW
      └─ tasks       (id, workflow_id, run_id, linear_issue_id, title, status)  NEW
         └─ effectiveness_scores  (id, task_id, dimension, score, detail, …)    NEW
```

Mapping to existing concepts (formalize, don't rebuild):
- **objective** — a goal pursued in a repo. Derived from a Linear project or created
  when `continueProject` runs (`source` ∈ `linear_project | continue | github_webhook |
  supervisor`). One row per (repo, goal).
- **workflow** — one autonomous pursuit of an objective: a `continueProject`
  invocation (plan → issues → land), or a single ad-hoc implement / `address_pr` run.
  `kind` ∈ `continue | implement | address_pr | fix`. NOTE: this hierarchy "workflow"
  is a data/organizing concept and is distinct from the Cloudflare `RunWorkflow`
  primitive (the durable execution engine for a single run) — a hierarchy workflow
  groups one-or-more tasks, each of which is realized by a `runs` row whose execution
  is driven by a `RunWorkflow` instance.
- **task** — a discrete unit (a Linear issue / a single `runs` row). `tasks.run_id`
  references the existing `runs` execution record; `tasks` is the durable spine the
  scores hang off.
- **effectiveness_scores** — per-task, per-`dimension` rows so we can add dimensions
  without migrations. Dimensions: `merged` (0/1), `tests_passed` (0/1),
  `time_to_merge_mins`, `agent_attempts`, `review_rounds`, `quality` (0–100,
  LLM-assessed). `score` is REAL; `detail` is text/JSON context.

**Rollup:** repo effectiveness = aggregate of its objectives = aggregate of workflows
= aggregate of tasks' scores. Computed on read via SQL aggregates (no denormalized
cache initially — YAGNI).

Tables (D1 migration `0001`-style, new tag in `wrangler.jsonc` migrations):
`objectives`, `workflows`, `tasks`, `effectiveness_scores`, plus `reports`
(id, kind `daily|weekly|repo`, period_start, period_end, repo_full_name nullable,
content_md, emailed_at, created_at), `repo_settings` (repo_full_name PK, paused
INTEGER, notes, updated_at), and `supervisor_alerts` (id, user_id, severity, title,
body, action_taken, run_id nullable, acknowledged_at, created_at).

Backfill: a one-time pass maps existing `runs` → `tasks` (+ synthesize the parent
`workflows`/`objectives` from `runs.project_id`/objective text) so the dashboard has
history. Idempotent; keyed on `tasks.run_id` uniqueness.

## SupervisorAgent (the core)

`export class SupervisorAgent extends Agent<Env, SupervisorState>` in
`worker/src/agents/supervisor.ts`, bound as a Durable Object (one instance per fly
user, `idFromName(flyUserId)` — mirrors `DevOrchestratorAgent`). New DO binding
`SUPERVISOR` + a `new_sqlite_classes` migration tag.

- **Memory (Session API):** the agent's own SQLite (`this.sql`) holds learned facts —
  per-repo failure patterns, flaky tests, what it has already alerted/acted on (so it
  doesn't repeat), and user preferences. Durable across restarts. A compact
  rolling "memory" context is fed to the LLM on each reasoning call (bounded tokens).
  Real-time UI bits (last tick, open alert count) live in `this.setState` state.
- **Scheduling (`onStart`, idempotent):**
  - `this.scheduleEvery(900, "watchTick")` — every 15 min: scan + score + intervene.
  - `this.schedule("0 9 * * *", "dailyDigest")` — daily report at 09:00 UTC.
  - `this.schedule("0 9 * * 1", "weeklyReport")` — weekly report Mondays 09:00 UTC.
- **`onRequest`** routes: chat (`/chat`), on-demand report (`/report`), and internal
  pokes (a run finished → score it now rather than waiting for the tick).

The existing per-5-min worker cron (`scheduled`) stays for the deterministic reaper;
the SupervisorAgent's own schedules drive the LLM-level work. The agent is woken by
its schedules and by `onRequest` from the worker (e.g., when `markRunCompleted`/
`markRunFailed` fire, the worker pings the user's SupervisorAgent to score the task).

## A. Effectiveness dashboard

A new dashboard view (`src/App.tsx` adds a "Supervisor" section, or a routed
`/supervisor` view via the existing `@tanstack/react-router`). Reads a new
`GET /api/supervisor/overview` returning the rollup:
- Top metrics: run success rate, **merge rate**, avg **time-to-merge**, test-pass
  rate, tasks this week, repos active.
- Per-repo table with an **effectiveness score** per repo, drill-down → objectives →
  workflows → tasks, each showing its rolled-up score + the task's PR/merge status.
- Failure-mode breakdown (clone/agent/test/push/merge) and recent `supervisor_alerts`.
- Recent `reports` list (click to read the markdown).
- The **chat panel** (subsystem C).

Metrics are SQL aggregates over `tasks` + `effectiveness_scores` + `runs`. The view
follows the existing Mantine `Card`/`Group`/`Table` patterns.

## B. Code reports

`dailyDigest` / `weeklyReport` agent methods (and an on-demand per-repo report):
1. Query the period's tasks/workflows/objectives + effectiveness scores.
2. LLM-summarize via the gateway (`env.AI.run("@cf/openai/gpt-oss-120b", …,
   { gateway })`) into markdown: what shipped (merged PRs), what's in progress,
   what's stuck/failing, per-repo effectiveness, notable interventions.
3. Persist to `reports`.
4. **Email** via a Cloudflare **Email binding** (`env.REPORT_EMAIL.send(...)`,
   `send_email` in wrangler.jsonc) to the user's address. The destination must be a
   verified Cloudflare Email Routing address; `emailed_at` is set on success and the
   failure is logged (report still stored in-app).

Per-repo reports are sections inside the daily/weekly digest AND available on demand
(`POST /api/supervisor/report { kind, repo }` → agent generates + stores + returns).

## C. Supervisor: watch → score → intervene (auto-act + notify) + self-repair

**Scoring (`scoreTask`)** — on each run/task completion the worker pings the agent,
which writes `effectiveness_scores` rows: deterministic dimensions from the run
result (`merged`, `tests_passed`, `time_to_merge_mins`, `agent_attempts`,
`review_rounds`) plus an LLM `quality` score (0–100) from the diff/summary.

**`watchTick`** — every 15 min the agent reads recent tasks/PRs/alerts, and the LLM
(via gateway, with the supervisor tool set) decides interventions. Auto-act + notify,
**bounded** (config caps: ≤N interventions/repo/hour, never re-act on an item already
in memory). Tools:
- `requeue_run(runId)` — re-queue a stuck/failed run (reuses `enqueueRun`).
- `comment_on_pr(repo, prNumber, body)` — leave a PR comment.
- `pause_repo(repo, reason)` — set `repo_settings.paused=1` so future auto-runs skip
  it; `createTaskRun` checks this flag.
- `dispatch_fix_run(repo, objective)` — **execute code in a sandbox to fix an issue**:
  creates an objective/workflow/task + a `mode:"implement"` run targeting the repo
  with a fix objective; it flows through the existing land-loop (clone → agent → fix
  tests until green → push → open PR → **merge only when passing**). This is how the
  agent "fixes issues in its own sandbox" — it reuses `SandboxContainer` + the run
  pipeline, not a new sandbox stack.
- `trigger_deploy(repo)` — **redeploy the app** after a fix lands: only callable once
  the fix PR is merged to the prod branch. For Cloudflare-deployed targets it triggers
  a deployment via the Cloudflare API (`CLOUDFLARE_API_TOKEN`) or by ensuring the merge
  to the production branch (which fires the target's CI). The land-loop's merge gate
  ensures a deploy never ships failing code.
- `escalate(severity, title, body)` — write a `supervisor_alerts` row (dashboard) and
  email the user via the Email binding.

**Safety bounds:** every action is recorded in the agent's memory + `supervisor_alerts`
with `action_taken`; per-repo/per-hour caps prevent runaway; `dispatch_fix_run` and
`trigger_deploy` inherit the land-loop's "merge/deploy only when green" gate; a global
`SUPERVISOR_AUTONOMY` env flag can downgrade to propose-only or off without a code
change. Known limitation (documented): redeploying fly-dev's **own container image**
can't be done from the Worker (no Docker; Workers Builds skips the container — see the
`fly-dev-workers-builds-skips-container` memory). The agent can trigger worker/CI
deploys and target-app deploys; container-image rebuilds for fly-dev itself still
require a Docker-capable `wrangler deploy` and are surfaced as an escalation instead.

### Chat support

`POST /api/supervisor/chat` (SSE) → forwards to the user's SupervisorAgent `/chat`.
Server uses **TanStack AI** `chat({ adapter, messages, tools })` with a custom adapter
implementing TanStack AI's adapter contract (returns an `AsyncIterable` of stream
chunks) backed by `env.AI.run("@cf/…", { stream:true }, { gateway:{id} })` — this keeps
the gateway rule and reuses the existing SSE streaming in `worker/src/index.ts`. (The
exact adapter interface is verified against `@tanstack/ai` docs during implementation;
fallback is to bypass `chat()` and stream `env.AI.run` directly to the `useChat`
client, doing tool-calling in our own loop.) Tools
exposed to chat: read-only queries (effectiveness, why-did-X-fail, list PRs) plus the
same intervention tools (so the user can ask it to act). The client chat panel uses
`@tanstack/ai-react` `useChat({ connection: fetchServerSentEvents("/api/supervisor/chat") })`.
Answers are grounded in the agent's Session memory + live SQL.

## Dependencies, bindings, config

- New deps: `@tanstack/ai`, `@tanstack/ai-react` (and an OpenAI-shaped adapter or a
  small custom adapter over `env.AI.run`). `agents` already present.
- `wrangler.jsonc`: new DO binding `SUPERVISOR` (class `SupervisorAgent`) + migration
  tag; `send_email` binding `REPORT_EMAIL` with the verified destination; vars
  `SUPERVISOR_AUTONOMY` (default `"auto"`).
- D1 migration adding the 7 new tables.
- All model calls via the gateway; no provider keys added.

## Error handling

- Agent methods never throw to the platform — wrap, log, write an alert on failure.
- Report email failure → still store the report; set no `emailed_at`; alert.
- LLM/gateway failure in scoring → write deterministic scores only, skip `quality`.
- Intervention tool failures → recorded, not retried blindly (respect caps).
- Chat stream errors → surfaced to `useChat` `onError`.

## Testing

- Pure functions unit-tested (existing vitest style, mocked `env`/`fetch`):
  effectiveness rollup aggregation, score computation from a run result, report
  markdown assembly, intervention cap logic, the watch-tick decision parsing.
- `SupervisorAgent` methods tested with a fake `env`/SQL where feasible; schedule
  wiring verified by typecheck.
- `npm test` + `npm run typecheck` stay green; container unaffected (the agent reuses
  the existing run pipeline, no `server.mjs` change required for the core).

## Build sequence (phases → each becomes plan tasks)

1. **Data model**: migration (7 tables), backfill runs→tasks, and `scoreTask` writing
   `effectiveness_scores` on run completion (worker side). + rollup query helpers.
2. **SupervisorAgent skeleton**: DO + binding + Session memory + `onStart` schedules +
   worker→agent ping on run completion.
3. **Reports**: `dailyDigest`/`weeklyReport`/per-repo + `reports` table + Cloudflare
   Email binding delivery.
4. **Dashboard**: `/api/supervisor/overview` + the Supervisor view (metrics +
   drill-down + reports list).
5. **Chat**: TanStack AI server adapter + `/api/supervisor/chat` SSE + `useChat` panel.
6. **Watch + intervene + self-repair**: `watchTick`, the tool set incl.
   `dispatch_fix_run` + `trigger_deploy`, autonomy flag + caps, alerts.

Each phase is independently shippable and testable.
