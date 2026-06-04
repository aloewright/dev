# Background Supervisor Agent Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. Dispatch each Task to a fresh subagent, review its diff against the spec, and only then move to the next Task. Steps use checkbox (- [ ]) syntax — check them off as you complete them; never batch multiple steps into one commit.

**Goal:** Build a persistent per-user `SupervisorAgent` (Cloudflare Agents SDK Durable Object) that watches the autonomous run pipeline, scores effectiveness, sends daily/weekly/per-repo code reports by email, surfaces a real-time effectiveness dashboard (Live Board + Data Board over the Agents WebSocket channel), answers questions in a TanStack-AI chat panel, and intervenes (requeue, comment, pause, dispatch a fix run, trigger deploy, escalate) within hard safety bounds.

**Architecture:** One `SupervisorAgent` per fly user, keyed canonically by the app **`user.id`** (`idFromName(user.id)`) on BOTH the server and the React client — this is the single most important invariant in the plan (global resolution G1). The server pings the agent and resolves every `/api/supervisor/*` route via `SUPERVISOR.idFromName(user.id)`; the React Live Board connects with `useAgent({ agent: 'supervisor', name: user.id })`. Because `this.name === user.id` inside the agent, all agent-side SQL filters on `WHERE user_id = this.name` correctly (`runs.user_id == app_users.id == user.id`). The DO is NOT keyed on `flyUserSlug` anywhere — `flyUserSlug` (e.g. `local-dev`) is a slugified value distinct from the `user_<uuid>` id, and keying on it would point the client socket at a different, empty DO instance than the one the worker scores into and broadcasts from. The worker pipeline pings the agent on every run lifecycle event; the agent scores tasks, maintains a bounded Session-API memory (auto-compacted via the native Agents SDK Session API), runs scheduled report/watch jobs, and `broadcast()`s live state to `useAgent`-connected React clients. A new D1 migration (`0005_supervisor.sql`) adds the 7-table effectiveness hierarchy. All scoring/report/judgment/chat LLM calls route through the Cloudflare AI Gateway via the sanctioned worker-side pattern `env.AI.run("@cf/openai/gpt-oss-120b", input, { gateway: { id } })` — dynamic routes and `fetch()` to the gateway do NOT resolve inside a Worker (see `~/.claude/CLAUDE.md`). NOTE (global resolution G3): Spec R3 / `docs/supervisor/MODELS.md` mandate `claude-opus-4-8` for the supervisor, but opus-4.8 is **not reachable from inside a Worker today** (no `@cf` Anthropic opus id exists; `dynamic/*` and gateway `fetch()` are both broken in-Worker). The in-Worker supervisor therefore runs on `@cf/openai/gpt-oss-120b` as a deliberate, load-bearing deviation that is surfaced to the user as an open decision in the Phase 6 / Notes section — NOT buried in a code comment.

**Tech Stack:** Cloudflare Workers + Hono (API), Durable Objects via `agents@0.13.2` (`Agent`, `routeAgentRequest`, `Session` from `agents/experimental/memory/session`, `createCompactFunction` from `agents/experimental/memory/utils`), D1 (SQLite), Cloudflare Email Workers (`cloudflare:email` + `mimetext`, **already a resolved dependency** — not re-installed), `@tanstack/ai` + `@tanstack/ai-react` (chat + tool-calling, the only two packages installed fresh), Mantine + TanStack React Router + React Query + `agents/react` `useAgent` (frontend), Vitest (tests). The supervisor LLM model in-Worker is `@cf/openai/gpt-oss-120b` via the AI Gateway (see Architecture note on the opus-4.8 tension, G3).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `migrations/0005_supervisor.sql` | Create | The 7 supervisor tables: `objectives`, `workflows`, `tasks`, `effectiveness_scores`, `reports`, `repo_settings`, `supervisor_alerts` + indexes. |
| `worker/src/platform/effectiveness.ts` | Create | Pure functions + D1 helpers: `computeDeterministicScores(result)`, `scoreTask(env, runId)` (reads `pr_url`/`commit_sha`/`branch_name` as real `runs` columns and `merged`/`testsRun`/`testsPassed`/`summary` via `json_extract(metadata_json,…)` AFTER the persist step — **no `diff`**, G2), rollup aggregates (`getSupervisorOverview`), the per-repo drill-down `getRepoDrilldown(env, userId, repoFullName)` with nested objectives→workflows→tasks rollup SQL (each level's rolled-up score + the task's run `pr_url`/merge status — issue #4), `backfillRunsToTasks(env)`, `ensureObjectiveWorkflowTask`. |
| `tests/effectiveness.test.ts` | Create | Unit tests for `computeDeterministicScores`, rollup math, the nested drill-down rollup query, backfill idempotence. |
| `worker/src/platform/orchestration.ts` | Modify | Add `pingSupervisor(env, userId, body)` helper resolving `SUPERVISOR.idFromName(owner.user_id)` (G1); extend `markRunCompleted` to persist the `ContainerRunResult` signals into the run BEFORE scoring via `UPDATE runs SET metadata_json = json_patch(metadata_json, ?) WHERE id = ?` merging `{merged, testsRun, testsPassed, summary}` (G2); call `pingSupervisor` from `markRunCompleted`/`markRunFailed`/`markRunStarted` and on each `recordRunEvent` for running runs (lifecycle forward). |
| `worker/src/agents/supervisor.ts` | Create | `SupervisorAgent extends Agent<Env, SupervisorState>`: Session memory + auto-compaction, `onStart` schedules, `fetch()` router (`/ping`, `/chat`, `/report`, `/board`), `watchTick`, `dailyDigest`, `weeklyReport`, `broadcast` of live/data board, intervention tool set. All agent SQL filters on `WHERE user_id = this.name` where `this.name === user.id` (G1). |
| `worker/src/agents/supervisor-prompts.ts` | Create | Pure prompt/markdown builders: `buildReportMarkdown`, `buildSummaryPrompt`, `buildWatchPrompt`, `parseWatchDecision`, `interventionAllowed` (cap logic). |
| `tests/supervisor-prompts.test.ts` | Create | Unit tests for report markdown assembly, watch decision parsing, intervention cap logic. |
| `worker/src/agents/supervisor-llm.ts` | Create | `supervisorSummarize(env, prompt)` and `supervisorChatStream(env, messages, tools)` — the gateway-bound `@cf/openai/gpt-oss-120b` callers used by the agent and chat (G3; carries the house-rule comment pointing at `~/.claude/CLAUDE.md` and the Notes deviation). |
| `worker/src/agents/supervisor-email.ts` | Create | `sendReportEmail(env, { subject, html, text })` over the `REPORT_EMAIL` binding (`cloudflare:email` + `mimetext`). |
| `worker/src/agents/supervisor-tools.ts` | Create | Intervention tool implementations: `requeueRun`, `commentOnPr`, `pauseRepo`, `dispatchFixRun`, `triggerDeploy`, `escalate` (reuse existing `enqueueRun`, `mergeWhenGreen`, `createTaskRun`, GitHub helpers). Shared by `watchTick` AND the chat tool-dispatch layer, gated by `interventionAllowed`/`SUPERVISOR_AUTONOMY`. |
| `worker/src/agents/supervisor-chat-tools.ts` | Create | Chat tool-dispatch layer (issue #5): the read-only query tools (effectiveness, why-did-X-fail, list PRs) plus the intervention tools from `supervisor-tools.ts`, exposed to the TanStack AI `chat({adapter, messages, tools})` loop (or the spec-allowed fallback that parses the model's tool intent and dispatches), gated by `interventionAllowed`/`SUPERVISOR_AUTONOMY`. |
| `worker/src/agents/supervisor-skills.ts` | Create | `loadSkillManifest(env)` + `readSkill(env, name)` — read-only R2 fetch of the superpowers manifest/skill text, aligned to the real `{name, r2_bucket, r2_key, description}` manifest shape. |
| `worker/src/env.ts` | Modify | Add `SUPERVISOR: DurableObjectNamespace`, `REPORT_EMAIL: SendEmail`, `SUPERVISOR_AUTONOMY`, `REPORT_FROM_ADDRESS`, `REPORT_TO_ADDRESS` to `Env`. |
| `worker/src/index.ts` | Modify | Export `SupervisorAgent`; persist `merged`/`testsRun`/`testsPassed`/`summary` into `runs.metadata_json` at the "mark run done" step (or via `markRunCompleted`, G2); add `/api/supervisor/*` routes (`overview`, `board`, `report`, `chat`, `pause`, and the drill-down `GET /api/supervisor/repo/:repoFullName`) each resolving `SUPERVISOR.idFromName(user.id)` (G1); widen lifecycle ping; keep `routeAgentRequest` (already covers `/agents/supervisor/...`). |
| `worker/src/platform/data.ts` | Modify | Add an `id` field to the app `Overview.user` shape returned by `getOverview` (≈line 289) so the frontend can key `useAgent` on `user.id` (G1). |
| `wrangler.jsonc` | Modify | DO binding `SUPERVISOR`, migration tag `v2` (`new_sqlite_classes: ["SupervisorAgent"]`), `send_email` binding `REPORT_EMAIL`, vars `SUPERVISOR_AUTONOMY`/`REPORT_FROM_ADDRESS`/`REPORT_TO_ADDRESS`. |
| `package.json` | Modify | Add `@tanstack/ai` + `@tanstack/ai-react` deps only (issue #12 — `mimetext` is ALREADY a resolved dependency and is NOT added). |
| `src/lib/supervisor.ts` | Create | Frontend types + fetch helpers for supervisor overview/board/report/drill-down. |
| `src/components/SupervisorPanel.tsx` | Create | Mantine effectiveness dashboard: metrics, per-repo drill-down via an expandable Mantine `Accordion`/nested `Table` (objectives→workflows→tasks with each level's rolled-up score + the task's run `pr_url`/merge status, issue #4), reports list, alerts. |
| `src/components/LiveBoard.tsx` | Create | Live Board + Data Board via `useAgent({ agent: 'supervisor', name: user.id })` (`agents/react`), polling fallback to `/api/supervisor/board`. Receives `userId` (the app `user.id`), NOT `flyUserSlug` (G1). |
| `src/components/SupervisorChat.tsx` | Create | TanStack-AI chat panel against `/api/supervisor/chat` with tool-calling (read-only queries + intervention tools); binds to the REAL exported hook/field names read from `node_modules/@tanstack/ai-react/dist/*.d.ts`. |
| `src/App.tsx` | Modify | Add an `id` field to the `Overview` type (≈line 28) so `overview.user.id` from the existing app overview query (NOT the supervisor overview, which has no `user` field) is available; read `user.id` from that app overview query (name the queries distinctly to avoid shadowing); mount `<SupervisorPanel />`, `<LiveBoard userId={overview.user.id} />`, `<SupervisorChat />` in a new Supervisor section (G1). |

---

## Phase 1 — Data model

### Task 1: Supervisor D1 migration (7 tables)

**Files:**
- Create: `migrations/0005_supervisor.sql`
- Test path: `tests/migration-0005.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/migration-0005.test.ts` that reads the SQL file and asserts the seven `CREATE TABLE` statements and the TEXT-id / FK conventions exist:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const sql = readFileSync(
  fileURLToPath(new URL("../migrations/0005_supervisor.sql", import.meta.url)),
  "utf8",
);

describe("0005_supervisor migration", () => {
  it("creates the seven supervisor tables", () => {
    for (const t of [
      "objectives",
      "workflows",
      "tasks",
      "effectiveness_scores",
      "reports",
      "repo_settings",
      "supervisor_alerts",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    }
  });

  it("uses TEXT ids and FK chain matching the existing schema", () => {
    expect(sql).toMatch(/objectives[\s\S]*?id TEXT PRIMARY KEY/);
    expect(sql).toMatch(/workflows[\s\S]*?objective_id TEXT NOT NULL REFERENCES objectives\(id\)/);
    expect(sql).toMatch(/tasks[\s\S]*?workflow_id TEXT NOT NULL REFERENCES workflows\(id\)/);
    expect(sql).toMatch(/tasks[\s\S]*?run_id TEXT[\s\S]*?REFERENCES runs\(id\)/);
    expect(sql).toMatch(/effectiveness_scores[\s\S]*?task_id TEXT NOT NULL REFERENCES tasks\(id\)/);
    expect(sql).toMatch(/UNIQUE\s*\(\s*run_id\s*\)/); // tasks.run_id idempotency key for backfill
  });

  it("keeps the TEXT CURRENT_TIMESTAMP + metadata_json conventions", () => {
    expect(sql).toMatch(/created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/metadata_json TEXT NOT NULL DEFAULT '\{\}'/);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- migration-0005`
  Expected: fails with `ENOENT … 0005_supervisor.sql` (file does not exist yet).

- [ ] **Step 3: Write the migration (minimal implementation).** Create `migrations/0005_supervisor.sql`:
```sql
-- AGPL-3.0-or-later
-- Supervisor effectiveness hierarchy. TEXT ids + TEXT CURRENT_TIMESTAMP +
-- metadata_json '{}' to match 0001. FK chain:
-- github_repos -> objectives -> workflows -> tasks -> effectiveness_scores;
-- reports -> objectives (nullable); repo_settings keyed on repo_full_name.

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,                       -- "obj_<uuid>"
  user_id TEXT NOT NULL REFERENCES app_users(id),
  repo_full_name TEXT,                       -- "owner/name" (nullable: not all objectives map to a repo)
  linear_project_id TEXT REFERENCES linear_projects(id),
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL DEFAULT 'supervisor', -- linear_project | continue | github_webhook | supervisor
  status TEXT NOT NULL DEFAULT 'active',     -- active | done | stalled
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,                        -- "wf_<uuid>"
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'implement',     -- continue | implement | address_pr | fix
  status TEXT NOT NULL DEFAULT 'running',     -- running | completed | failed
  started_at TEXT,
  finished_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                        -- "task_<uuid>"
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id),           -- the runs row this task is realized by
  linear_issue_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',     -- mirrors runs.status (queued|running|completed|failed|cancelled)
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id)                            -- backfill idempotency key (one task per run)
);

CREATE TABLE IF NOT EXISTS effectiveness_scores (
  id TEXT PRIMARY KEY,                        -- "score_<uuid>"
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id),
  dimension TEXT NOT NULL,                    -- merged | tests_passed | time_to_merge_mins | agent_attempts | review_rounds | quality
  score REAL NOT NULL DEFAULT 0,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, dimension)                 -- one row per (task, dimension); re-score upserts
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,                        -- "report_<uuid>"
  user_id TEXT NOT NULL REFERENCES app_users(id),
  objective_id TEXT REFERENCES objectives(id),
  kind TEXT NOT NULL,                         -- daily | weekly | repo
  period_start TEXT,
  period_end TEXT,
  repo_full_name TEXT,
  content_md TEXT NOT NULL DEFAULT '',
  emailed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repo_settings (
  repo_full_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  paused INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supervisor_alerts (
  id TEXT PRIMARY KEY,                        -- "alert_<uuid>"
  user_id TEXT NOT NULL REFERENCES app_users(id),
  severity TEXT NOT NULL DEFAULT 'info',      -- info | warn | error | critical
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  action_taken TEXT,
  run_id TEXT REFERENCES runs(id),
  acknowledged_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_objectives_user_status ON objectives(user_id, status);
CREATE INDEX IF NOT EXISTS idx_objectives_repo ON objectives(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_workflows_objective ON workflows(objective_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_scores_task ON effectiveness_scores(task_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_created ON reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON supervisor_alerts(user_id, created_at DESC);
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- migration-0005`
  Expected: 3 passing tests.

- [ ] **Step 5: Apply the migration locally to verify SQL validity.** `npm run migrate:local`
  Expected output includes `🚣 7 migrations` / no SQL error; the new tables apply cleanly.

- [ ] **Step 6: Commit.** `git add migrations/0005_supervisor.sql tests/migration-0005.test.ts && git commit -m "feat(supervisor): add 0005 effectiveness-hierarchy migration"`

---

### Task 2: Effectiveness scoring + rollup helpers

**Files:**
- Create: `worker/src/platform/effectiveness.ts`
- Test path: `tests/effectiveness.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/effectiveness.test.ts` covering the pure score computation and the rollup math (no DB):
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import {
  computeDeterministicScores,
  rollupRepoScore,
} from "../worker/src/platform/effectiveness";

describe("computeDeterministicScores", () => {
  it("scores a merged, tested run with timings", () => {
    const scores = computeDeterministicScores({
      ok: true,
      merged: true,
      testsRun: true,
      testsPassed: true,
      startedAt: "2026-06-04T10:00:00Z",
      mergedAt: "2026-06-04T10:30:00Z",
      attempt: 1,
    });
    const byDim = Object.fromEntries(scores.map((s) => [s.dimension, s.score]));
    expect(byDim.merged).toBe(1);
    expect(byDim.tests_passed).toBe(1);
    expect(byDim.time_to_merge_mins).toBe(30);
    expect(byDim.agent_attempts).toBe(1);
  });

  it("omits tests_passed when no tests ran and scores a failed run as 0 merged", () => {
    const scores = computeDeterministicScores({ ok: false, merged: false, testsRun: false, attempt: 2 });
    const dims = scores.map((s) => s.dimension);
    expect(dims).toContain("merged");
    expect(dims).not.toContain("tests_passed");
    expect(scores.find((s) => s.dimension === "merged")?.score).toBe(0);
    expect(scores.find((s) => s.dimension === "agent_attempts")?.score).toBe(2);
  });
});

describe("rollupRepoScore", () => {
  it("averages merged + tests_passed + normalized quality into a 0-100 repo score", () => {
    // two tasks: one merged+tested+quality 80, one not merged, quality 40
    const score = rollupRepoScore([
      { merged: 1, tests_passed: 1, quality: 80 },
      { merged: 0, tests_passed: 0, quality: 40 },
    ]);
    // merged avg .5 *100=50, tests avg .5*100=50, quality avg 60 -> mean = 53.33 -> rounded 53
    expect(score).toBe(53);
  });

  it("returns 0 for no tasks", () => {
    expect(rollupRepoScore([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- effectiveness`
  Expected: fails to resolve `../worker/src/platform/effectiveness`.

- [ ] **Step 3: Implement the pure functions + DB helpers (minimal).** Create `worker/src/platform/effectiveness.ts`:
```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { all, first, id, runSql } from "./data";

export type RunScoreInput = {
  ok: boolean;
  merged?: boolean | null;
  testsRun?: boolean | null;
  testsPassed?: boolean | null;
  startedAt?: string | null;
  mergedAt?: string | null;
  attempt?: number | null;
  reviewRounds?: number | null;
};

export type DimensionScore = { dimension: string; score: number; detail?: string };

// Deterministic, LLM-free score rows derived purely from the run result.
export function computeDeterministicScores(input: RunScoreInput): DimensionScore[] {
  const out: DimensionScore[] = [];
  out.push({ dimension: "merged", score: input.merged ? 1 : 0 });
  if (input.testsRun) {
    out.push({ dimension: "tests_passed", score: input.testsPassed ? 1 : 0 });
  }
  if (input.merged && input.startedAt && input.mergedAt) {
    const mins =
      (Date.parse(input.mergedAt) - Date.parse(input.startedAt)) / 60000;
    if (Number.isFinite(mins) && mins >= 0) {
      out.push({ dimension: "time_to_merge_mins", score: Math.round(mins) });
    }
  }
  out.push({ dimension: "agent_attempts", score: Math.max(1, input.attempt ?? 1) });
  if (typeof input.reviewRounds === "number") {
    out.push({ dimension: "review_rounds", score: input.reviewRounds });
  }
  return out;
}

// Repo effectiveness = mean of (merged%, tests_passed%, avg quality), 0-100.
export function rollupRepoScore(
  tasks: Array<{ merged?: number; tests_passed?: number; quality?: number }>,
): number {
  if (tasks.length === 0) return 0;
  const avg = (pick: (t: (typeof tasks)[number]) => number | undefined) => {
    const vals = tasks.map(pick).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const mergedPct = avg((t) => t.merged) * 100;
  const testsPct = avg((t) => t.tests_passed) * 100;
  const qualityAvg = avg((t) => t.quality);
  return Math.round((mergedPct + testsPct + qualityAvg) / 3);
}

// Find-or-create the objective/workflow/task spine for a run. Idempotent on
// tasks.run_id (UNIQUE). Returns the task id.
export async function ensureObjectiveWorkflowTask(
  env: Env,
  run: {
    id: string;
    user_id: string;
    objective: string;
    project_id: string | null;
    status: string;
    repoFullName: string | null;
    linearIssueId: string | null;
    kind?: string;
  },
): Promise<string> {
  const existing = await first<{ id: string }>(
    env,
    "SELECT id FROM tasks WHERE run_id = ?",
    [run.id],
  );
  if (existing) return existing.id;

  // One objective per (user, repo, objective-text). Reuse if present.
  let objective = await first<{ id: string }>(
    env,
    "SELECT id FROM objectives WHERE user_id = ? AND COALESCE(repo_full_name,'') = ? AND title = ? LIMIT 1",
    [run.user_id, run.repoFullName ?? "", run.objective],
  );
  let objectiveId = objective?.id ?? id("obj");
  if (!objective) {
    await runSql(
      env,
      `INSERT INTO objectives (id, user_id, repo_full_name, linear_project_id, title, source, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [objectiveId, run.user_id, run.repoFullName, run.project_id, run.objective, "continue"],
    );
  }

  const workflowId = id("wf");
  await runSql(
    env,
    `INSERT INTO workflows (id, objective_id, kind, status, started_at)
     VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
    [workflowId, objectiveId, run.kind ?? "implement"],
  );

  const taskId = id("task");
  await runSql(
    env,
    `INSERT OR IGNORE INTO tasks (id, workflow_id, run_id, linear_issue_id, title, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, workflowId, run.id, run.linearIssueId, run.objective, run.status],
  );
  const stored = await first<{ id: string }>(env, "SELECT id FROM tasks WHERE run_id = ?", [run.id]);
  return stored?.id ?? taskId;
}

// Upsert deterministic dimension rows for a task (UNIQUE(task_id, dimension)).
export async function writeScores(
  env: Env,
  taskId: string,
  runId: string | null,
  scores: DimensionScore[],
): Promise<void> {
  for (const s of scores) {
    await runSql(
      env,
      `INSERT INTO effectiveness_scores (id, task_id, run_id, dimension, score, detail)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, dimension) DO UPDATE SET
         score = excluded.score, detail = excluded.detail, run_id = excluded.run_id`,
      [id("score"), taskId, runId, s.dimension, s.score, s.detail ?? null],
    );
  }
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- effectiveness`
  Expected: 4 passing tests.

- [ ] **Step 5: Typecheck.** `npm run typecheck`
  Expected: no errors.

- [ ] **Step 6: Commit.** `git add worker/src/platform/effectiveness.ts tests/effectiveness.test.ts && git commit -m "feat(supervisor): effectiveness score computation + rollup + task-spine helpers"`

---

### Task 3: scoreTask + backfill, wired on run completion

**Files:**
- Modify: `worker/src/platform/effectiveness.ts`
- Modify: `worker/src/platform/orchestration.ts`
- Modify: `worker/src/index.ts` (pass the full `ContainerRunResult` into the widened `markRunCompleted`)
- Test path: `tests/score-task.test.ts`
- Test path: `tests/mark-run-completed-persist.test.ts`
- Test path: `tests/supervisor-do-key.test.ts`

> **G2 — persist run-result signals BEFORE scoring, read them from one place.** `runs.metadata_json` (written by `createTaskRun`) only ever holds `{source, mode, prNumber, linearIssueId, linearTeamId, repoOwner, repoName}`. The signals scoring needs — `merged`, `testsRun`, `testsPassed`, `summary` — are written ONLY into the `run_events` row with `event_type='agent.result'` (worker/src/index.ts ~lines 1018-1034), and **no `diff` is persisted anywhere**. So this task FIRST widens `markRunCompleted` to merge `{merged, testsRun, testsPassed, summary}` into `runs.metadata_json` via `json_patch`, THEN has `scoreTask` read `pr_url`/`commit_sha`/`branch_name` as real `runs` **columns** (added in 0002) and `merged`/`testsRun`/`testsPassed`/`summary` via `json_extract(metadata_json,'$.…')` AFTER the persist. **`diff` is dropped from the quality-score input entirely** (it does not exist); the quality score is computed from `summary` plus the deterministic signals.

> **G1 — SupervisorAgent DO identity = the app `user.id`, everywhere.** `pingSupervisor` resolves `SUPERVISOR.idFromName(owner.user_id)`. Inside the agent `this.name === user.id`, so all agent SQL `WHERE user_id = this.name` is correct — never key the agent's SQL on the slug. Step 9 adds a test asserting the value passed to `idFromName` equals the value used in the `user_id` WHERE clause.

- [ ] **Step 1: Write the failing test for `scoreTask`.** Create `tests/score-task.test.ts` driving `scoreTask` against an in-memory fake `env.DB` capturing SQL, asserting it ensures a task spine and writes deterministic score rows (mocking `env.AI.run` so the quality call is exercised through the gateway pattern). Note the fake `runs` row mirrors the REAL schema: `pr_url`/`commit_sha`/`branch_name` are columns, while `merged`/`testsRun`/`testsPassed`/`summary` live **only** inside `metadata_json` (as the widened `markRunCompleted` of Step 5 persists them). There is **no `diff`**:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { scoreTask } from "../worker/src/platform/effectiveness";

function fakeEnv() {
  const rows: Record<string, unknown[]> = { tasks: [], scores: [], objectives: [], workflows: [] };
  const seen: { ai?: { model: string; opts: unknown } } = {};
  // Mirrors the real runs schema after markRunCompleted's persist:
  //   pr_url/commit_sha/branch_name are COLUMNS;
  //   merged/testsRun/testsPassed/summary live ONLY in metadata_json (no diff).
  const run = {
    id: "run_1",
    user_id: "user_1",
    objective: "Add login",
    project_id: null,
    status: "completed",
    metadata_json: JSON.stringify({
      repoOwner: "o",
      repoName: "r",
      merged: 1,
      testsRun: 1,
      testsPassed: 1,
      summary: "added login",
    }),
    // json_extract(metadata_json,'$.merged') etc. resolve to these values:
    merged: 1,
    tests_run: 1,
    tests_passed: 1,
    summary: "added login",
    started_at: "2026-06-04T10:00:00Z",
    finished_at: "2026-06-04T10:20:00Z",
    pr_url: "https://github.com/o/r/pull/1",
    commit_sha: "abc123",
    branch_name: "feature/login",
  };
  const env = {
    AI_GATEWAY_ID: "x",
    AI: {
      run: async (model: string, _i: unknown, opts: unknown) => {
        seen.ai = { model, opts };
        return { choices: [{ message: { content: "85" } }] };
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind: (...v: unknown[]) => ({
            async all() {
              if (/FROM runs WHERE id/.test(sql)) return { results: [run] };
              if (/FROM tasks WHERE run_id/.test(sql)) {
                return { results: rows.tasks.length ? [{ id: "task_1" }] : [] };
              }
              if (/FROM objectives/.test(sql)) return { results: [] };
              return { results: [] };
            },
            async run() {
              if (/INSERT (OR IGNORE )?INTO tasks/.test(sql)) rows.tasks.push(v);
              if (/INTO effectiveness_scores/.test(sql)) rows.scores.push({ sql, v });
              if (/INTO objectives/.test(sql)) rows.objectives.push(v);
              if (/INTO workflows/.test(sql)) rows.workflows.push(v);
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
  } as never;
  return { env, rows, seen };
}

describe("scoreTask", () => {
  it("creates the task spine and writes deterministic + quality scores via the gateway", async () => {
    const { env, rows, seen } = fakeEnv();
    await scoreTask(env, "run_1");
    expect(rows.tasks.length).toBeGreaterThan(0);
    const dims = rows.scores.map((s: any) => s.v[3]); // dimension is the 4th bound param
    expect(dims).toContain("merged");
    expect(dims).toContain("tests_passed");
    expect(dims).toContain("time_to_merge_mins");
    expect(dims).toContain("quality");
    expect(seen.ai?.model).toBe("@cf/openai/gpt-oss-120b");
    expect(seen.ai?.opts).toEqual({ gateway: { id: "x" } });
  });

  it("still writes deterministic scores when the gateway throws (no quality row)", async () => {
    const { env, rows } = fakeEnv();
    (env as any).AI.run = async () => {
      throw new Error("gateway down");
    };
    await scoreTask(env, "run_1");
    const dims = rows.scores.map((s: any) => s.v[3]);
    expect(dims).toContain("merged");
    expect(dims).not.toContain("quality");
  });

  it("produces a quality score from summary alone (no diff is ever read)", async () => {
    const { env, rows, seen } = fakeEnv();
    // The SELECT must not reference a diff column/key; quality still fires off summary.
    await scoreTask(env, "run_1");
    const dims = rows.scores.map((s: any) => s.v[3]);
    expect(dims).toContain("quality");
    expect(seen.ai?.model).toBe("@cf/openai/gpt-oss-120b");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- score-task`
  Expected: fails — `scoreTask` is not exported.

- [ ] **Step 3: Implement `scoreTask`, `getSupervisorOverview`, `getBoardData`, and `backfillRunsToTasks` (minimal).** Append to `worker/src/platform/effectiveness.ts`. Note: `pr_url`/`commit_sha`/`branch_name` are read as real `runs` columns; `merged`/`tests_run`/`tests_passed`/`summary` are read via `json_extract` from the metadata persisted by `markRunCompleted` (Step 5); **there is no `diff`** anywhere — the quality call is fed `summary` only:
```ts
const QUALITY_MODEL = "@cf/openai/gpt-oss-120b"; // gateway-routed; see ~/.claude/CLAUDE.md "Inside a Worker"

// Score one run's task: deterministic rows always; quality (0-100) via the
// AI Gateway when a summary exists. Never throws (caller is the pipeline).
// G2: merged/testsRun/testsPassed/summary are read from runs.metadata_json,
// which markRunCompleted patches in from the ContainerRunResult BEFORE scoring;
// pr_url/commit_sha/branch_name are real runs columns. No diff is persisted.
export async function scoreTask(env: Env, runId: string): Promise<void> {
  const run = await first<{
    id: string;
    user_id: string;
    objective: string;
    project_id: string | null;
    status: string;
    metadata_json: string;
    merged: number | null;
    tests_run: number | null;
    tests_passed: number | null;
    started_at: string | null;
    finished_at: string | null;
    pr_url: string | null;
    commit_sha: string | null;
    branch_name: string | null;
    summary: string | null;
  }>(
    env,
    `SELECT id, user_id, objective, project_id, status, metadata_json,
            json_extract(metadata_json,'$.merged')       AS merged,
            json_extract(metadata_json,'$.testsRun')     AS tests_run,
            json_extract(metadata_json,'$.testsPassed')  AS tests_passed,
            started_at, finished_at, pr_url, commit_sha, branch_name,
            json_extract(metadata_json,'$.summary')      AS summary
       FROM runs WHERE id = ?`,
    [runId],
  );
  if (!run) return;

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const owner = typeof meta.repoOwner === "string" ? meta.repoOwner : null;
  const name = typeof meta.repoName === "string" ? meta.repoName : null;
  const repoFullName = owner && name ? `${owner}/${name}` : null;
  const attempt = typeof meta.retryCount === "number" ? meta.retryCount + 1 : 1;
  const linearIssueId = typeof meta.linearIssueId === "string" ? meta.linearIssueId : null;

  const taskId = await ensureObjectiveWorkflowTask(env, {
    id: run.id,
    user_id: run.user_id,
    objective: run.objective,
    project_id: run.project_id,
    status: run.status,
    repoFullName,
    linearIssueId,
  });

  await runSql(env, "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE run_id = ?", [
    run.status,
    run.id,
  ]);

  const det = computeDeterministicScores({
    ok: run.status === "completed",
    merged: run.merged === 1,
    testsRun: run.tests_run === 1,
    testsPassed: run.tests_passed === 1,
    startedAt: run.started_at,
    mergedAt: run.merged === 1 ? run.finished_at : null,
    attempt,
  });
  await writeScores(env, taskId, run.id, det);

  // Quality (0-100) via gateway, computed from the agent summary. Non-fatal.
  // G2: diff is intentionally dropped — it is never persisted, so we never read it.
  if (run.summary) {
    try {
      const quality = await llmQualityScore(env, run.objective, run.summary);
      if (quality != null) {
        await writeScores(env, taskId, run.id, [{ dimension: "quality", score: quality }]);
      }
    } catch {
      // gateway failure -> deterministic scores only
    }
  }
}

async function llmQualityScore(
  env: Env,
  objective: string,
  summary: string | null,
): Promise<number | null> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  // G2: no diff is available; score from the objective + the agent's own summary.
  const prompt =
    `Objective: ${objective}\nAgent summary of the change: ${summary ?? "(none)"}\n\n` +
    "Based on the objective and the summary of what the agent changed, rate the code " +
    "change quality from 0 to 100. Respond with ONLY the integer.";
  // House-rule: inside a Worker only @cf/<model> ids resolve through the AI binding;
  // dynamic/* routes and fetch() to the gateway are broken in-Worker. See
  // ~/.claude/CLAUDE.md "Inside a Worker". Route through the gateway for caching/obs.
  const raw = await (
    env.AI as unknown as {
      run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
    }
  ).run(
    QUALITY_MODEL,
    { messages: [{ role: "user", content: prompt }], max_tokens: 8 },
    { gateway: { id: gatewayId } },
  );
  const text = (raw as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
    ?.content;
  const n = Number.parseInt((text ?? "").match(/\d+/)?.[0] ?? "", 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

export type SupervisorOverview = {
  metrics: {
    runSuccessRate: number;
    mergeRate: number;
    avgTimeToMergeMins: number;
    testPassRate: number;
    tasksThisWeek: number;
    reposActive: number;
  };
  repos: Array<{ repoFullName: string; score: number; tasks: number; merged: number }>;
  failureModes: Array<{ mode: string; count: number }>;
  alerts: Array<{ id: string; severity: string; title: string; body: string; createdAt: string }>;
  reports: Array<{ id: string; kind: string; repoFullName: string | null; createdAt: string }>;
};

export async function getSupervisorOverview(env: Env, userId: string): Promise<SupervisorOverview> {
  const taskRows = await all<{ merged: number; tests_passed: number; quality: number; repo: string | null }>(
    env,
    `SELECT
       COALESCE(MAX(CASE WHEN es.dimension='merged' THEN es.score END),0) AS merged,
       COALESCE(MAX(CASE WHEN es.dimension='tests_passed' THEN es.score END),0) AS tests_passed,
       COALESCE(MAX(CASE WHEN es.dimension='quality' THEN es.score END),0) AS quality,
       o.repo_full_name AS repo
     FROM tasks t
     JOIN workflows w ON w.id = t.workflow_id
     JOIN objectives o ON o.id = w.objective_id
     LEFT JOIN effectiveness_scores es ON es.task_id = t.id
     WHERE o.user_id = ?
     GROUP BY t.id`,
    [userId],
  );

  const byRepo = new Map<string, Array<{ merged: number; tests_passed: number; quality: number }>>();
  for (const r of taskRows) {
    const key = r.repo ?? "(unmapped)";
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key)!.push({ merged: r.merged, tests_passed: r.tests_passed, quality: r.quality });
  }
  const repos = [...byRepo.entries()].map(([repoFullName, ts]) => ({
    repoFullName,
    score: rollupRepoScore(ts),
    tasks: ts.length,
    merged: ts.filter((t) => t.merged === 1).length,
  }));

  const total = taskRows.length || 1;
  const merged = taskRows.filter((t) => t.merged === 1).length;
  const tested = taskRows.filter((t) => t.tests_passed === 1).length;
  const timeRows = await all<{ avg: number | null }>(
    env,
    `SELECT AVG(es.score) AS avg FROM effectiveness_scores es
     JOIN tasks t ON t.id = es.task_id
     JOIN workflows w ON w.id = t.workflow_id
     JOIN objectives o ON o.id = w.objective_id
     WHERE o.user_id = ? AND es.dimension = 'time_to_merge_mins'`,
    [userId],
  );
  const weekRows = await first<{ c: number }>(
    env,
    `SELECT COUNT(*) AS c FROM tasks t
     JOIN workflows w ON w.id = t.workflow_id
     JOIN objectives o ON o.id = w.objective_id
     WHERE o.user_id = ? AND t.created_at >= datetime('now','-7 days')`,
    [userId],
  );
  const failureModes = await all<{ mode: string; count: number }>(
    env,
    `SELECT
       CASE
         WHEN last_error LIKE 'clone%' THEN 'clone'
         WHEN last_error LIKE 'push%'  THEN 'push'
         WHEN last_error LIKE '%test%' THEN 'test'
         WHEN last_error LIKE '%merge%' THEN 'merge'
         WHEN last_error IS NOT NULL THEN 'agent'
         ELSE 'none' END AS mode,
       COUNT(*) AS count
     FROM runs WHERE user_id = ? AND status = 'failed' GROUP BY mode`,
    [userId],
  );
  const alerts = await all<{ id: string; severity: string; title: string; body: string; createdAt: string }>(
    env,
    `SELECT id, severity, title, body, created_at AS createdAt FROM supervisor_alerts
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
    [userId],
  );
  const reports = await all<{ id: string; kind: string; repoFullName: string | null; createdAt: string }>(
    env,
    `SELECT id, kind, repo_full_name AS repoFullName, created_at AS createdAt FROM reports
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
    [userId],
  );

  return {
    metrics: {
      runSuccessRate: Math.round((merged / total) * 100) / 100,
      mergeRate: Math.round((merged / total) * 100) / 100,
      avgTimeToMergeMins: Math.round(timeRows[0]?.avg ?? 0),
      testPassRate: Math.round((tested / total) * 100) / 100,
      tasksThisWeek: weekRows?.c ?? 0,
      reposActive: repos.length,
    },
    repos,
    failureModes: failureModes.filter((f) => f.mode !== "none"),
    alerts,
    reports,
  };
}

export type BoardData = {
  queued: number;
  running: number;
  // Issue #14: this is the SUM of github_repos.open_issues — a GitHub count, NOT
  // a Linear count. Labeled/named for GitHub to match its real source. Keep this
  // field name consistent with the "Issues open" metric label in SupervisorPanel (sec-4).
  githubIssuesOpen: number;
  completedToday: number;
  completedThisWeek: number;
  completedThisMonth: number;
  completedAllTime: number;
};

export async function getBoardData(env: Env, userId: string): Promise<BoardData> {
  const counts = await first<{ queued: number; running: number }>(
    env,
    `SELECT
       SUM(CASE WHEN status IN ('queued','waiting_approval') THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
     FROM runs WHERE user_id = ?`,
    [userId],
  );
  // Issue #14: github_repos.open_issues is a GitHub repo open-issue count (migrations/0004).
  // Surface it under githubIssuesOpen, not a Linear-named field. No SQL change — relabel only.
  const githubIssues = await first<{ c: number }>(
    env,
    "SELECT COALESCE(SUM(open_issues),0) AS c FROM github_repos WHERE user_id = ?",
    [userId],
  );
  const completed = await first<{ d: number; w: number; m: number; a: number }>(
    env,
    `SELECT
       SUM(CASE WHEN finished_at >= datetime('now','start of day') THEN 1 ELSE 0 END) AS d,
       SUM(CASE WHEN finished_at >= datetime('now','-7 days')      THEN 1 ELSE 0 END) AS w,
       SUM(CASE WHEN finished_at >= datetime('now','-30 days')     THEN 1 ELSE 0 END) AS m,
       COUNT(*) AS a
     FROM runs WHERE user_id = ? AND status = 'completed'`,
    [userId],
  );
  return {
    queued: counts?.queued ?? 0,
    running: counts?.running ?? 0,
    githubIssuesOpen: githubIssues?.c ?? 0,
    completedToday: completed?.d ?? 0,
    completedThisWeek: completed?.w ?? 0,
    completedThisMonth: completed?.m ?? 0,
    completedAllTime: completed?.a ?? 0,
  };
}

// One-time, idempotent: fold every existing run into a task spine + scores.
// Keyed on tasks.run_id uniqueness, so a second pass re-scores in place.
export async function backfillRunsToTasks(env: Env, userId: string): Promise<{ scored: number }> {
  const runs = await all<{ id: string }>(
    env,
    `SELECT id FROM runs WHERE user_id = ? AND status IN ('completed','failed')
     ORDER BY created_at ASC LIMIT 500`,
    [userId],
  );
  let scored = 0;
  for (const r of runs) {
    await scoreTask(env, r.id);
    scored += 1;
  }
  return { scored };
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- score-task`
  Expected: 3 passing tests.

- [ ] **Step 5: Write the failing test for the `markRunCompleted` persist (G2 — persist BEFORE scoring).** Create `tests/mark-run-completed-persist.test.ts`. `markRunCompleted` must merge `{merged, testsRun, testsPassed, summary}` from the `ContainerRunResult` into `runs.metadata_json` via `json_patch` — so `scoreTask`'s `json_extract` reads find them. **No `diff`** is persisted:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { markRunCompleted } from "../worker/src/platform/orchestration";

function fakeEnv() {
  const calls: Array<{ sql: string; v: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (...v: unknown[]) => ({
            async all() {
              if (/FROM runs WHERE id/.test(sql)) {
                return { results: [{ user_id: "user_1" }] };
              }
              return { results: [] };
            },
            async run() {
              calls.push({ sql, v });
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
    // SUPERVISOR absent -> pingSupervisor is a no-op in this unit test.
  } as never;
  return { env, calls };
}

describe("markRunCompleted persists run-result signals (G2)", () => {
  it("merges merged/testsRun/testsPassed/summary into metadata_json via json_patch and never persists diff", async () => {
    const { env, calls } = fakeEnv();
    await markRunCompleted(env, "run_1", {
      prUrl: "https://github.com/o/r/pull/1",
      commitSha: "abc123",
      branchName: "feature/login",
      merged: true,
      testsRun: true,
      testsPassed: true,
      diff: "diff --git a b", // present on the result but MUST be dropped
      summary: "added login",
    });
    const patch = calls.find((c) => /json_patch\(metadata_json/.test(c.sql));
    expect(patch).toBeDefined();
    const patchObj = JSON.parse(patch!.v[0] as string);
    expect(patchObj).toEqual({
      merged: 1,
      testsRun: 1,
      testsPassed: 1,
      summary: "added login",
    });
    expect(patchObj).not.toHaveProperty("diff");
    // pr_url/commit_sha/branch_name stay as COLUMNS on the status update.
    const statusUpdate = calls.find((c) => /SET status = 'completed', pr_url = \?/.test(c.sql));
    expect(statusUpdate).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the persist test (expected FAIL).** `npm test -- mark-run-completed-persist`
  Expected: fails — `markRunCompleted`'s current narrow signature accepts only `{prUrl, commitSha, branchName}` and emits no `json_patch` update.

- [ ] **Step 7: Widen `markRunCompleted` to persist the signals BEFORE scoring (G2).** In `worker/src/platform/orchestration.ts`, replace the existing `markRunCompleted` (lines ~247-262) with the version below. It (a) keeps `pr_url`/`commit_sha`/`branch_name` as columns, (b) merges `{merged, testsRun, testsPassed, summary}` into `metadata_json` via `json_patch` (JSON-stringifying the patch object, coercing booleans to 1/0 so `json_extract … = 1` checks in `scoreTask` work), and (c) **drops `diff`** (never persisted):
```ts
export async function markRunCompleted(
  env: Env,
  runId: string,
  result: {
    prUrl?: string | null;
    commitSha?: string | null;
    branchName?: string | null;
    // G2: run-result signals scoreTask needs. diff is intentionally NOT accepted/persisted.
    merged?: boolean | null;
    testsRun?: boolean | null;
    testsPassed?: boolean | null;
    summary?: string | null;
  },
): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'completed', pr_url = ?, commit_sha = ?, branch_name = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [result.prUrl ?? null, result.commitSha ?? null, result.branchName ?? null, runId],
  );

  // G2: persist the deterministic + summary signals INTO runs.metadata_json so
  // scoreTask reads them from one place (json_extract). pr_url/commit_sha/branch_name
  // stay as columns above. No diff is ever persisted. Booleans -> 1/0 for json_extract checks.
  const patch: Record<string, unknown> = {
    merged: result.merged ? 1 : 0,
    testsRun: result.testsRun ? 1 : 0,
    testsPassed: result.testsPassed ? 1 : 0,
    summary: result.summary ?? null,
  };
  await runSql(
    env,
    "UPDATE runs SET metadata_json = json_patch(metadata_json, ?) WHERE id = ?",
    [JSON.stringify(patch), runId],
  );

  await recordRunEvent(env, runId, "run.completed", "Run completed.", "info", {
    prUrl: result.prUrl ?? null,
  });
  await pingSupervisor(env, runId, "completed");
}
```

- [ ] **Step 8: Update the caller in `worker/src/index.ts` to pass the full result into `markRunCompleted`.** Find the `mark run done` step (the call site near line ~1056 that currently passes `{ prUrl, commitSha, branchName }`) and extend it so the new signals flow through. Replace that call with:
```ts
      await markRunCompleted(env, run.id, {
        prUrl: result.prUrl ?? null,
        commitSha: result.commitSha ?? null,
        branchName: result.branch ?? null,
        // G2: feed the persist step. diff is intentionally omitted (never persisted).
        merged: result.merged ?? null,
        testsRun: result.testsRun ?? null,
        testsPassed: result.testsPassed ?? null,
        summary: result.summary ? redactSecrets(result.summary).slice(-4000) : null,
      });
```

- [ ] **Step 9: Run the persist test (expected PASS).** `npm test -- mark-run-completed-persist`
  Expected: 1 passing test — the `json_patch` update is emitted with exactly `{merged, testsRun, testsPassed, summary}` and no `diff`.

- [ ] **Step 10: Write the failing G1 invariant test (DO key == user_id WHERE clause).** Create `tests/supervisor-do-key.test.ts` asserting that the value `pingSupervisor` passes to `idFromName` is exactly the `user_id` it resolved from the run — i.e. the DO instance name equals the value the agent uses in its `WHERE user_id = this.name` queries (G1):
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { pingSupervisor } from "../worker/src/platform/orchestration";

describe("pingSupervisor DO identity (G1)", () => {
  it("keys idFromName on the run's user_id — the same value the agent filters runs.user_id by", async () => {
    const seen: { idFromNameArg?: string; bodyUserId?: string } = {};
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind: (..._v: unknown[]) => ({
              async all() {
                if (/SELECT user_id FROM runs WHERE id/.test(sql)) {
                  return { results: [{ user_id: "user_abc" }] };
                }
                return { results: [] };
              },
              async run() {
                return { meta: { changes: 0 } };
              },
            }),
          };
        },
      },
      SUPERVISOR: {
        idFromName(name: string) {
          seen.idFromNameArg = name;
          return { name };
        },
        get(_idObj: { name: string }) {
          return {
            async fetch(req: Request) {
              const body = (await req.json()) as { userId: string };
              seen.bodyUserId = body.userId;
              return new Response("ok");
            },
          };
        },
      },
    } as never;

    await pingSupervisor(env, "run_1", "completed");
    // G1: idFromName arg, the ping body userId, and the runs.user_id are all identical.
    expect(seen.idFromNameArg).toBe("user_abc");
    expect(seen.bodyUserId).toBe("user_abc");
    expect(seen.idFromNameArg).toBe(seen.bodyUserId);
  });
});
```

- [ ] **Step 11: Run the G1 test (expected FAIL).** `npm test -- supervisor-do-key`
  Expected: fails — `pingSupervisor` is not yet exported from `orchestration.ts`.

- [ ] **Step 12: Wire the ping helper + remaining lifecycle hooks into orchestration (G1).** In `worker/src/platform/orchestration.ts`, add a `pingSupervisor` helper near the top (after imports), keyed on the run's `user_id` per G1 (the agent's `this.name === user.id`, so this is the same value its `WHERE user_id = this.name` queries use). Ensure the imports line includes `first` (e.g. `import { first, id, recordRunEvent, recordUsage, runSql } from "./data";`), then insert:
```ts
// Notify the user's SupervisorAgent of a run lifecycle event (score now / live board).
// Fire-and-forget: failures here must never break the run pipeline.
// G1: the DO instance name is the app user.id (runs.user_id). Inside the agent
// this.name === user.id, so its `WHERE user_id = this.name` queries match. NEVER
// key this on flyUserSlug — that would point the WS client and scorer at different DOs.
export async function pingSupervisor(
  env: Env,
  runId: string,
  kind: "started" | "completed" | "failed" | "event",
): Promise<void> {
  try {
    const owner = await first<{ user_id: string }>(env, "SELECT user_id FROM runs WHERE id = ?", [runId]);
    if (!owner) return;
    const ns = env.SUPERVISOR;
    if (!ns) return; // binding absent in some test contexts
    const stub = ns.get(ns.idFromName(owner.user_id));
    await stub.fetch(
      new Request("https://supervisor/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, kind, userId: owner.user_id }),
      }),
    );
  } catch {
    // non-fatal
  }
}
```
The `await pingSupervisor(env, runId, "completed")` call is already added at the end of the widened `markRunCompleted` (Step 7). Now add the sibling calls: at the end of `markRunFailed` (after its `recordRunEvent`) add `await pingSupervisor(env, runId, "failed");`, and at the end of `markRunStarted` add `await pingSupervisor(env, runId, "started");`.

- [ ] **Step 13: Run the G1 test (expected PASS).** `npm test -- supervisor-do-key`
  Expected: 1 passing test — `idFromName` arg, ping `userId`, and `runs.user_id` are all `"user_abc"`.

- [ ] **Step 14: Forward in-flight run events to the supervisor.** In `worker/src/platform/data.ts` `recordRunEvent`, after the `runSql` insert add a lifecycle forward gated on `env.SUPERVISOR` (cheap; the agent decides what to broadcast). The lazy import avoids a cycle, and `pingSupervisor` itself resolves the DO by `user.id` (G1):
```ts
  // Widen the run-completion ping to all lifecycle events for running runs so the
  // SupervisorAgent's Live Board stays current (R1). Lazy import avoids a cycle.
  // G1: pingSupervisor keys the DO on runs.user_id, matching the WS client name.
  if (env.SUPERVISOR) {
    try {
      const { pingSupervisor } = await import("./orchestration");
      await pingSupervisor(env, runId, "event");
    } catch {
      // non-fatal
    }
  }
```

- [ ] **Step 15: Run tests + typecheck.** `npm test && npm run typecheck`
  Expected: all green — `score-task` (3), `mark-run-completed-persist` (1), `supervisor-do-key` (1), plus prior suites. The orchestration ping uses optional `env.SUPERVISOR`; the `Env` change for the `SUPERVISOR` binding lands in Task 4 — if typecheck flags the missing field, proceed to Task 4 before committing, otherwise commit now.

- [ ] **Step 16: Commit.** `git add worker/src/platform/effectiveness.ts worker/src/platform/orchestration.ts worker/src/platform/data.ts worker/src/index.ts tests/score-task.test.ts tests/mark-run-completed-persist.test.ts tests/supervisor-do-key.test.ts && git commit -m "feat(supervisor): scoreTask + persist run signals before scoring + board queries + backfill + lifecycle ping"`

---

## Phase 2 — SupervisorAgent skeleton + Session memory

### Task 4: Env bindings + wrangler config + deps

**Files:**
- Modify: `worker/src/env.ts`
- Modify: `wrangler.jsonc`
- Modify: `package.json`
- Test path: `tests/wrangler-supervisor.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/wrangler-supervisor.test.ts` asserting the wrangler config declares the SUPERVISOR DO binding, the v2 migration tag, and the email binding:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const text = readFileSync(
  fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  "utf8",
);

describe("wrangler supervisor wiring", () => {
  it("declares the SUPERVISOR durable object binding", () => {
    expect(text).toMatch(/"name":\s*"SUPERVISOR"/);
    expect(text).toMatch(/"class_name":\s*"SupervisorAgent"/);
  });
  it("adds the v2 new_sqlite_classes migration tag for SupervisorAgent", () => {
    expect(text).toMatch(/"tag":\s*"v2"/);
    expect(text).toMatch(/"new_sqlite_classes":\s*\[\s*"SupervisorAgent"\s*\]/);
  });
  it("declares the REPORT_EMAIL send_email binding and SUPERVISOR_AUTONOMY var", () => {
    expect(text).toMatch(/"send_email":\s*\[/);
    expect(text).toMatch(/"name":\s*"REPORT_EMAIL"/);
    expect(text).toMatch(/"SUPERVISOR_AUTONOMY":\s*"auto"/);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- wrangler-supervisor`
  Expected: 3 failing assertions (config not yet updated).

- [ ] **Step 3: Update `worker/src/env.ts`.** Add to the `Env` type (after `DEV_ORCHESTRATOR`):
```ts
  SUPERVISOR: DurableObjectNamespace;
```
and after `MYBROWSER?: unknown;` add:
```ts
  REPORT_EMAIL?: { send(message: unknown): Promise<unknown> };
```
and in the vars block (after `CONTINUE_EXECUTE_CAP?`):
```ts
  SUPERVISOR_AUTONOMY?: string;        // "auto" | "propose" | "off"
  REPORT_FROM_ADDRESS?: string;        // verified Email Routing sender
  REPORT_TO_ADDRESS?: string;          // verified destination
```

- [ ] **Step 4: Update `wrangler.jsonc`.** In `durable_objects.bindings` append:
```jsonc
      {
        "name": "SUPERVISOR",
        "class_name": "SupervisorAgent"
      }
```
In `migrations` append a new tag:
```jsonc
    {
      "tag": "v2",
      "new_sqlite_classes": ["SupervisorAgent"]
    }
```
Add a top-level `send_email` binding block (after `r2_buckets`):
```jsonc
  "send_email": [
    {
      "name": "REPORT_EMAIL",
      "destination_address": "pleasewritemealetter@gmail.com"
    }
  ],
```
In `vars` add:
```jsonc
    "SUPERVISOR_AUTONOMY": "auto",
    "REPORT_FROM_ADDRESS": "reports@fly.pm",
    "REPORT_TO_ADDRESS": "pleasewritemealetter@gmail.com"
```

- [ ] **Step 5: Add deps.** `@tanstack/ai` and `@tanstack/ai-react` are absent from `node_modules` and must be installed. `mimetext` is ALREADY a resolved dependency (`node_modules/mimetext` present with the exact API later phases use: `createMimeMessage`, `setSender`, `setRecipient`, `setSubject`, `addMessage`, `asRaw`) — do NOT reinstall it. Run:
```bash
npm install @tanstack/ai @tanstack/ai-react
```
  Expected: `package.json` dependencies gain ONLY the two TanStack packages (`@tanstack/ai`, `@tanstack/ai-react`); `package-lock.json` updates for those two. Confirm `mimetext` is already listed:
```bash
node -e "console.log(require('./package.json').dependencies.mimetext ? 'mimetext present: '+require('./package.json').dependencies.mimetext : 'MISSING')"
```
  Expected: prints `mimetext present: <version>` (i.e. it was already a dependency and the install did not add it).

- [ ] **Step 6: Run the test (expected PASS).** `npm test -- wrangler-supervisor`
  Expected: 3 passing tests.

- [ ] **Step 7: Commit.** `git add worker/src/env.ts wrangler.jsonc package.json package-lock.json tests/wrangler-supervisor.test.ts && git commit -m "feat(supervisor): env bindings, SUPERVISOR DO, REPORT_EMAIL, tanstack-ai deps"`

---

### Task 5: SupervisorAgent skeleton with Session memory + auto-compaction

**Files:**
- Create: `worker/src/agents/supervisor-llm.ts`
- Create: `worker/src/agents/supervisor.ts`
- Modify: `worker/src/index.ts`
- Test path: `tests/supervisor-summarize.test.ts`
- Test path: `tests/supervisor-do-identity.test.ts`

> **DO identity invariant (G1).** The SupervisorAgent Durable Object is keyed on the app `user.id` everywhere — the server resolves `SUPERVISOR.idFromName(user.id)` on every route and ping, so inside the agent `this.name === user.id`. Because `runs.user_id === app_users.id === user.id`, every agent-side query that filters `WHERE user_id = this.name` is correct against the real schema. NEVER key the agent (or its SQL) on `flyUserSlug` — `flyUserSlug` (e.g. `local-dev`, from `auth-session.ts` slugify) is a distinct field from `user.id` (`user_<uuid>`), and keying on it would point the WebSocket client at an empty DO instance while the worker scores/broadcasts into a different one. The HTTP control route param below is named `flyUserId` for parity with the existing `/agents/orchestrator/:flyUserId` route, but the value passed to it by every `/api/supervisor/*` caller and by `pingSupervisor` is `user.id`, not the slug. The model used by every in-Worker supervisor LLM call is `@cf/openai/gpt-oss-120b` per G3 (see the model-tension note below and `supervisor-llm.ts`).

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-summarize.test.ts` for the gateway-bound summarize helper used by `createCompactFunction` and reports:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { supervisorSummarize } from "../worker/src/agents/supervisor-llm";

describe("supervisorSummarize", () => {
  it("routes through the AI Gateway with the @cf model and returns text", async () => {
    const seen: { model?: string; opts?: unknown } = {};
    const env = {
      AI_GATEWAY_ID: "x",
      AI: {
        run: async (model: string, _i: unknown, opts: unknown) => {
          seen.model = model;
          seen.opts = opts;
          return { choices: [{ message: { content: "compact summary" } }] };
        },
      },
    } as never;
    const out = await supervisorSummarize(env, "summarize this long history");
    expect(out).toBe("compact summary");
    // G3: in-Worker supervisor LLM calls run on @cf/openai/gpt-oss-120b (only
    // gateway-resolvable Worker model id today; opus-4.8 is not reachable here).
    expect(seen.model).toBe("@cf/openai/gpt-oss-120b");
    expect(seen.opts).toEqual({ gateway: { id: "x" } });
  });

  it("returns an empty string when the gateway throws (non-fatal compaction)", async () => {
    const env = {
      AI_GATEWAY_ID: "x",
      AI: { run: async () => { throw new Error("down"); } },
    } as never;
    expect(await supervisorSummarize(env, "x")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-summarize`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the LLM helper.** Create `worker/src/agents/supervisor-llm.ts`:
```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";

// Supervisor LLM tier. HOUSE RULE / G3: route through the Cloudflare AI Gateway.
// Inside a Worker/DO the ONLY working pattern is
//   env.AI.run("@cf/<model>", input, { gateway: { id } })
// dynamic/* routes and fetch() to the gateway do NOT resolve in a Worker
// (see ~/.claude/CLAUDE.md "Inside a Worker"). Spec R3 / docs/supervisor/MODELS.md
// want the supervisor on claude-opus-4-8, but there is no @cf Anthropic opus model
// and opus-4.8 is unreachable from a Worker today. So this is a deliberate,
// documented deviation: the supervisor reasons on @cf/openai/gpt-oss-120b in-Worker.
// See the "House-rule tension: supervisor model" note in Phase 6 / Notes — this is
// an OPEN DECISION surfaced to the user, with a future option to escalate specific
// high-stakes judgments to a Node/HTTPS dynamic/research_gen path. Swap the model id
// below back to a dynamic route once Worker-side dynamic routing is fixed upstream.
const SUPERVISOR_MODEL = "@cf/openai/gpt-oss-120b";

type AiRunner = {
  run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
};

function readContent(raw: unknown): string {
  const r = raw as { choices?: Array<{ message?: { content?: string | null } }> };
  return r?.choices?.[0]?.message?.content ?? "";
}

// Used by createCompactFunction({ summarize }) and by report generation.
// Non-fatal: returns "" on gateway error so compaction degrades gracefully.
export async function supervisorSummarize(env: Env, prompt: string): Promise<string> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  try {
    const raw = await (env.AI as unknown as AiRunner).run(
      SUPERVISOR_MODEL,
      { messages: [{ role: "user", content: prompt }], max_tokens: 1024 },
      { gateway: { id: gatewayId } },
    );
    return readContent(raw);
  } catch {
    return "";
  }
}

// One-shot completion with a system + user prompt (reports, watch decisions).
export async function supervisorComplete(
  env: Env,
  system: string,
  user: string,
  maxTokens = 1500,
): Promise<string> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  try {
    const raw = await (env.AI as unknown as AiRunner).run(
      SUPERVISOR_MODEL,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      },
      { gateway: { id: gatewayId } },
    );
    return readContent(raw);
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-summarize`
  Expected: 2 passing tests.

- [ ] **Step 5: Implement the SupervisorAgent skeleton with Session memory.** Create `worker/src/agents/supervisor.ts`. The agent follows this repo's existing `DevOrchestratorAgent` pattern (an `Agent`-subclass DO with a `fetch()` override reached via `idFromName(...)` from a `/agents/...` control route). Per G1, `this.name` is the app `user.id`, so every `WHERE user_id = this.name` query below is correct against `runs.user_id`:
```ts
/* AGPL-3.0-or-later */
import { Agent } from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import type { Env } from "../env";
import { getBoardData, getSupervisorOverview, scoreTask } from "../platform/effectiveness";
import { supervisorSummarize } from "./supervisor-llm";

export type SupervisorState = {
  lastTick: string | null;
  openAlertCount: number;
  liveRunIds: string[];
};

export class SupervisorAgent extends Agent<Env, SupervisorState> {
  initialState: SupervisorState = { lastTick: null, openAlertCount: 0, liveRunIds: [] };

  // G1 invariant: this DO is keyed by the app user.id everywhere (every
  // /api/supervisor/* route and pingSupervisor resolve idFromName(user.id)), so
  // this.name === user.id === runs.user_id. All SQL below filters
  // `WHERE user_id = this.name` and is correct against the real schema. Do NOT
  // key this agent or its SQL on flyUserSlug.

  // Session-API memory over this DO's SQLite (this.sql). Auto-compacts older
  // history with the LLM through the AI Gateway (R2). Built lazily once.
  private session: Session | null = null;

  private getSession(): Session {
    if (this.session) return this.session;
    // Session.create(this) auto-wires AgentSessionProvider over this.sql.
    // summarize routes through the Cloudflare AI Gateway on @cf/openai/gpt-oss-120b
    // (house rule / G3 — see supervisor-llm.ts).
    this.session = Session.create(this)
      .withContext("memory", { maxTokens: 1500 })
      .onCompaction(createCompactFunction({ summarize: (prompt) => supervisorSummarize(this.env, prompt) }))
      .compactAfter(50_000)
      .withCachedPrompt();
    return this.session;
  }

  // Idempotent schedule wiring. schedule() is idempotent by default on (cron, cb).
  override async onStart(): Promise<void> {
    this.getSession();
    await this.scheduleEvery(900, "watchTick");        // every 15 min: scan + score + intervene
    await this.schedule("0 9 * * *", "dailyDigest");    // daily 09:00 UTC report
    await this.schedule("0 9 * * 1", "weeklyReport");   // weekly Monday 09:00 UTC report
  }

  // Worker -> agent pings + on-demand requests. Mirrors DevOrchestratorAgent's
  // fetch() override (this repo's pattern). routeAgentRequest also exposes
  // /chat etc. over WebSocket; HTTP control routes live here. this.name is the
  // app user.id (G1), so it is the value we use to query runs.user_id below.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/ping")) {
      const body = (await request.json().catch(() => ({}))) as {
        runId?: string;
        kind?: string;
        userId?: string;
      };
      return this.handlePing(body);
    }
    if (request.method === "GET" && url.pathname.endsWith("/board")) {
      const data = await getBoardData(this.env, this.name);
      return Response.json(data);
    }
    return Response.json({ ok: true, agent: "supervisor", user: this.name, state: this.state });
  }

  // Score a finished run immediately; update + broadcast the live/data board for
  // any lifecycle event (R1). Never throws to the platform.
  private async handlePing(body: { runId?: string; kind?: string }): Promise<Response> {
    try {
      if (body.runId && (body.kind === "completed" || body.kind === "failed")) {
        await scoreTask(this.env, body.runId);
      }
      await this.broadcastBoards();
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Recompute and push the Live Board (running runs) + Data Board (counters) on
  // the Agents SDK WebSocket channel. One message updates both panels. Because
  // this DO is keyed by user.id (G1), the React client's
  // useAgent({ agent: 'supervisor', name: user.id }) connects to THIS instance and
  // receives these broadcasts.
  async broadcastBoards(): Promise<void> {
    const board = await getBoardData(this.env, this.name);
    const liveRuns = await this.loadLiveRuns();
    this.setState({ ...this.state, lastTick: new Date().toISOString(), liveRunIds: liveRuns.map((r) => r.id) });
    this.broadcast(JSON.stringify({ type: "board", board, live: liveRuns }));
  }

  private async loadLiveRuns(): Promise<
    Array<{ id: string; objective: string; status: string; stage: string | null; updatedAt: string }>
  > {
    // this.name === user.id === runs.user_id (G1).
    const rows = await this.env.DB.prepare(
      `SELECT r.id, r.objective, r.status, r.updated_at AS updatedAt,
              (SELECT message FROM run_events e WHERE e.run_id = r.id ORDER BY e.created_at DESC LIMIT 1) AS stage
         FROM runs r WHERE r.user_id = ? AND r.status = 'running'
         ORDER BY r.updated_at DESC LIMIT 20`,
    )
      .bind(this.name)
      .all<{ id: string; objective: string; status: string; updatedAt: string; stage: string | null }>();
    return rows.results ?? [];
  }

  // Filled in later phases. Stubs keep schedule() callbacks valid (keyof this).
  async watchTick(): Promise<void> {
    this.setState({ ...this.state, lastTick: new Date().toISOString() });
  }
  async dailyDigest(): Promise<void> {}
  async weeklyReport(): Promise<void> {}
}
```

- [ ] **Step 6: Export the agent + add the control route in `worker/src/index.ts`.** Add the import near the other platform imports:
```ts
import { SupervisorAgent } from "./agents/supervisor";
```
Re-export it next to `ContainerProxy` so wrangler can bind the DO class:
```ts
export { SupervisorAgent };
```
Add an HTTP control route (after the existing `/agents/orchestrator/:flyUserId` route) so the worker can reach a specific user's supervisor. Per G1, the value callers pass for `:flyUserId` is the app `user.id` (NOT `flyUserSlug`); the param keeps the `flyUserId` name only for parity with the orchestrator route. `idFromName(idArg)` therefore equals the same instance the agent queries via `this.name`:
```ts
app.all("/agents/supervisor/:flyUserId", async (c) => {
  // G1: the path segment is the app user.id (callers resolve idFromName(user.id)),
  // so this.name inside the agent equals runs.user_id. Param name is historical.
  const idArg = c.req.param("flyUserId");
  const stub = c.env.SUPERVISOR.get(c.env.SUPERVISOR.idFromName(idArg));
  return stub.fetch(c.req.raw);
});
```

- [ ] **Step 7: Write the failing DO-identity test (G1 invariant).** Create `tests/supervisor-do-identity.test.ts`. It asserts the value passed to `idFromName` is the same value the agent uses in its `user_id` WHERE clause — i.e. the control route keys the DO by exactly the id segment it receives, and the agent's board query binds `this.name` to `runs.user_id`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it, vi } from "vitest";
import { SupervisorAgent } from "../worker/src/agents/supervisor";

describe("SupervisorAgent DO identity (G1)", () => {
  it("queries runs.user_id with this.name (the value passed to idFromName)", async () => {
    const APP_USER_ID = "user_abc123";
    const bound: unknown[] = [];
    const env = {
      DB: {
        prepare: (_sql: string) => ({
          bind: (...args: unknown[]) => {
            bound.push(...args);
            return { all: async () => ({ results: [] }) };
          },
        }),
      },
    } as never;

    // Construct the agent without running the DO runtime; force this.name to the
    // app user.id that the control route resolved via idFromName(user.id).
    const agent = Object.create(SupervisorAgent.prototype) as SupervisorAgent & {
      name: string;
      env: typeof env;
      state: unknown;
      setState: (s: unknown) => void;
      broadcast: (s: string) => void;
    };
    agent.name = APP_USER_ID;
    agent.env = env;
    agent.state = { lastTick: null, openAlertCount: 0, liveRunIds: [] };
    agent.setState = vi.fn();
    agent.broadcast = vi.fn();

    // loadLiveRuns is private; reach it via the prototype to exercise the SQL bind.
    const loadLiveRuns = (SupervisorAgent.prototype as unknown as {
      loadLiveRuns: () => Promise<unknown>;
    }).loadLiveRuns;
    await loadLiveRuns.call(agent);

    // The single bound parameter must equal the DO name (== idFromName arg == user.id).
    expect(bound).toEqual([APP_USER_ID]);
    expect(bound[0]).toBe(agent.name);
  });

  it("never uses a flyUserSlug-shaped value for the runs query", async () => {
    // Regression guard: a slug like 'local-dev' must NOT be what we bind.
    const APP_USER_ID = "user_def456";
    const bound: unknown[] = [];
    const env = {
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            bound.push(...args);
            return { all: async () => ({ results: [] }) };
          },
        }),
      },
    } as never;
    const agent = Object.create(SupervisorAgent.prototype) as SupervisorAgent & {
      name: string;
      env: typeof env;
    };
    agent.name = APP_USER_ID;
    agent.env = env;
    const loadLiveRuns = (SupervisorAgent.prototype as unknown as {
      loadLiveRuns: () => Promise<unknown>;
    }).loadLiveRuns;
    await loadLiveRuns.call(agent);
    expect(bound[0]).not.toBe("local-dev");
    expect(bound[0]).toMatch(/^user_/);
  });
});
```

- [ ] **Step 8: Run the DO-identity test (expected PASS).** `npm test -- supervisor-do-identity`
  Expected: 2 passing tests — confirming the agent binds `this.name` (the `idFromName(user.id)` value) to the `runs.user_id` WHERE clause and never a slug.

- [ ] **Step 9: Typecheck + dry-run.** `npm run typecheck && npm run cf:dry-run`
  Expected: typecheck clean; `cf:dry-run` succeeds and lists the `SupervisorAgent` DO + `REPORT_EMAIL` binding (validates the wrangler wiring + that `Session.create(this)` typechecks against the installed agents SDK).

- [ ] **Step 10: Commit.** `git add worker/src/agents/supervisor.ts worker/src/agents/supervisor-llm.ts worker/src/index.ts tests/supervisor-summarize.test.ts tests/supervisor-do-identity.test.ts && git commit -m "feat(supervisor): SupervisorAgent skeleton + Session memory auto-compaction + schedules (DO keyed on user.id)"`

---

## Phase 3 — Reports + Email

### Task 6: Report markdown assembly + email binding

**Files:**
- Create: `worker/src/agents/supervisor-prompts.ts`
- Create: `worker/src/agents/supervisor-email.ts`
- Modify: `worker/src/agents/supervisor.ts`
- Test path: `tests/supervisor-prompts.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-prompts.test.ts` for the pure markdown builder + the summarize-prompt builder:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { buildReportMarkdown, buildSummaryPrompt } from "../worker/src/agents/supervisor-prompts";

const fixture = {
  kind: "daily" as const,
  periodStart: "2026-06-03",
  periodEnd: "2026-06-04",
  repos: [
    { repoFullName: "o/r", score: 72, tasks: 4, merged: 3 },
    { repoFullName: "o/s", score: 50, tasks: 2, merged: 1 },
  ],
  merged: [{ repo: "o/r", title: "Add login", prUrl: "https://github.com/o/r/pull/1" }],
  inProgress: [{ repo: "o/r", title: "Refactor auth" }],
  stuck: [{ repo: "o/s", title: "Flaky test", error: "test failed" }],
  interventions: [{ title: "Requeued run_9", action: "requeue_run" }],
  llmNarrative: "Strong day; auth shipped.",
};

describe("buildReportMarkdown", () => {
  it("renders a markdown report with the key sections", () => {
    const md = buildReportMarkdown(fixture);
    expect(md).toMatch(/# Daily Code Report/);
    expect(md).toMatch(/o\/r/);
    expect(md).toMatch(/Add login/);
    expect(md).toMatch(/Refactor auth/);
    expect(md).toMatch(/Flaky test/);
    expect(md).toMatch(/Requeued run_9/);
    expect(md).toMatch(/Strong day; auth shipped\./);
  });
  it("handles empty sections without throwing", () => {
    const md = buildReportMarkdown({ ...fixture, merged: [], inProgress: [], stuck: [], interventions: [] });
    expect(md).toMatch(/_None_/);
  });
});

describe("buildSummaryPrompt", () => {
  it("packs the structured period data into a single LLM prompt", () => {
    const p = buildSummaryPrompt(fixture);
    expect(p).toMatch(/Add login/);
    expect(p).toMatch(/Produce a concise narrative/);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-prompts`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the prompt/markdown builders.** Create `worker/src/agents/supervisor-prompts.ts`:
```ts
/* AGPL-3.0-or-later */

export type ReportData = {
  kind: "daily" | "weekly" | "repo";
  periodStart: string;
  periodEnd: string;
  repos: Array<{ repoFullName: string; score: number; tasks: number; merged: number }>;
  merged: Array<{ repo: string; title: string; prUrl?: string | null }>;
  inProgress: Array<{ repo: string; title: string }>;
  stuck: Array<{ repo: string; title: string; error?: string | null }>;
  interventions: Array<{ title: string; action: string }>;
  llmNarrative?: string;
};

const TITLES: Record<ReportData["kind"], string> = {
  daily: "Daily Code Report",
  weekly: "Weekly Code Report",
  repo: "Repo Code Report",
};

function list<T>(items: T[], render: (x: T) => string): string {
  if (items.length === 0) return "_None_";
  return items.map((x) => `- ${render(x)}`).join("\n");
}

export function buildReportMarkdown(d: ReportData): string {
  return [
    `# ${TITLES[d.kind]}`,
    `_${d.periodStart} → ${d.periodEnd}_`,
    "",
    d.llmNarrative ? d.llmNarrative + "\n" : "",
    "## Per-repo effectiveness",
    list(d.repos, (r) => `**${r.repoFullName}** — score ${r.score}/100 (${r.merged}/${r.tasks} merged)`),
    "",
    "## Shipped (merged PRs)",
    list(d.merged, (m) => `${m.repo}: ${m.title}${m.prUrl ? ` — ${m.prUrl}` : ""}`),
    "",
    "## In progress",
    list(d.inProgress, (m) => `${m.repo}: ${m.title}`),
    "",
    "## Stuck / failing",
    list(d.stuck, (m) => `${m.repo}: ${m.title}${m.error ? ` (${m.error})` : ""}`),
    "",
    "## Interventions",
    list(d.interventions, (i) => `${i.title} (${i.action})`),
    "",
  ].join("\n");
}

export function buildSummaryPrompt(d: ReportData): string {
  return [
    `Period: ${d.periodStart} → ${d.periodEnd}`,
    `Merged PRs: ${d.merged.map((m) => `${m.repo}/${m.title}`).join("; ") || "none"}`,
    `In progress: ${d.inProgress.map((m) => `${m.repo}/${m.title}`).join("; ") || "none"}`,
    `Stuck: ${d.stuck.map((m) => `${m.repo}/${m.title}`).join("; ") || "none"}`,
    `Per-repo scores: ${d.repos.map((r) => `${r.repoFullName}=${r.score}`).join(", ") || "none"}`,
    "",
    "Produce a concise narrative (3-5 sentences) summarizing what shipped, what is in",
    "progress, what is stuck, and overall effectiveness. No preamble, no markdown headers.",
  ].join("\n");
}

// Minimal markdown -> HTML for the email body (headings, bold, bullets, links).
export function markdownToHtml(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${esc(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${esc(line.slice(3))}</h2>`;
      if (line.startsWith("- ")) return `<li>${inline(line.slice(2))}</li>`;
      if (line.trim() === "") return "<br/>";
      return `<p>${inline(line)}</p>`;
    })
    .join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>');
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-prompts`
  Expected: 3 passing tests.

- [ ] **Step 5: Write the failing email test.** Create `tests/supervisor-email.test.ts`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { sendReportEmail } from "../worker/src/agents/supervisor-email";

describe("sendReportEmail", () => {
  it("sends a MIME message via the REPORT_EMAIL binding and resolves true", async () => {
    let sent: unknown = null;
    const env = {
      REPORT_FROM_ADDRESS: "reports@fly.pm",
      REPORT_TO_ADDRESS: "pleasewritemealetter@gmail.com",
      REPORT_EMAIL: { send: async (m: unknown) => { sent = m; return { messageId: "abc" }; } },
    } as never;
    const ok = await sendReportEmail(env, { subject: "Daily", html: "<h1>Hi</h1>", text: "Hi" });
    expect(ok).toBe(true);
    expect(sent).not.toBeNull();
  });

  it("returns false (non-fatal) when the binding is absent", async () => {
    const env = { REPORT_FROM_ADDRESS: "a@b", REPORT_TO_ADDRESS: "c@d" } as never;
    expect(await sendReportEmail(env, { subject: "x", html: "y", text: "z" })).toBe(false);
  });
});
```

- [ ] **Step 6: Run the email test (expected FAIL).** `npm test -- supervisor-email`
  Expected: fails — module not found.

- [ ] **Step 7: Implement the email sender.** Create `worker/src/agents/supervisor-email.ts`. `mimetext` is already a resolved dependency (`node_modules/mimetext` exposes `createMimeMessage`, `setSender`, `setRecipient`, `setSubject`, `addMessage`, `asRaw`) — no install needed here:
```ts
/* AGPL-3.0-or-later */
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { Env } from "../env";

// Send a report via the Cloudflare Email Workers binding (REPORT_EMAIL). The
// sender must be a verified Email Routing domain; the destination must be a
// verified address. Non-fatal: returns false on any failure so the report is
// still stored in-app (spec: error handling).
export async function sendReportEmail(
  env: Env,
  msg: { subject: string; html: string; text: string },
): Promise<boolean> {
  const from = env.REPORT_FROM_ADDRESS;
  const to = env.REPORT_TO_ADDRESS;
  if (!env.REPORT_EMAIL || !from || !to) return false;
  try {
    const mime = createMimeMessage();
    mime.setSender({ name: "fly-dev Supervisor", addr: from });
    mime.setRecipient(to);
    mime.setSubject(msg.subject);
    mime.addMessage({ contentType: "text/plain", data: msg.text });
    mime.addMessage({ contentType: "text/html", data: msg.html });
    const message = new EmailMessage(from, to, mime.asRaw());
    await env.REPORT_EMAIL.send(message);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 8: Run the email test (expected PASS).** `npm test -- supervisor-email`
  Expected: 2 passing tests. (Note: `cloudflare:email` resolves under the workers vitest pool; if the node pool cannot resolve it, the test mocks `EmailMessage` — but the binding-absent test path exercises the false branch without constructing one. If import resolution fails in node, gate the import behind a dynamic `await import("cloudflare:email")` inside the try; keep the false-on-absence test green.)

- [ ] **Step 9: Commit.** `git add worker/src/agents/supervisor-prompts.ts worker/src/agents/supervisor-email.ts tests/supervisor-prompts.test.ts tests/supervisor-email.test.ts && git commit -m "feat(supervisor): report markdown assembly + Cloudflare email binding"`

---

### Task 7: dailyDigest / weeklyReport / on-demand report generation

**Files:**
- Modify: `worker/src/agents/supervisor.ts`
- Modify: `worker/src/index.ts`
- Test path: `tests/supervisor-report.test.ts`

> **G1 invariant (DO identity).** The `SupervisorAgent` Durable Object is keyed by the app `user.id` everywhere: `pingSupervisor` resolves `SUPERVISOR.idFromName(owner.user_id)`, every `/api/supervisor/*` route resolves `SUPERVISOR.idFromName(user.id)`, and the client `useAgent({ name: user.id })`. Therefore inside the agent `this.name === user.id`, and `runs.user_id === app_users.id === user.id`. All report SQL in this task filters `WHERE r.user_id = ?` with that same `user.id`, and `runReport` passes `this.name` as the `userId` — they are the same value by construction. Do NOT key any of this on `flyUserSlug`.

> **G2 invariant (run-result signals).** The merge/test/summary signals are NOT columns on `runs` and are NOT in `createTaskRun`'s `metadata_json` (which holds only `{source, mode, prNumber, linearIssueId, linearTeamId, repoOwner, repoName}`). Task 3 adds a persist step that extends `markRunCompleted` to merge `{merged, testsRun, testsPassed, summary}` into `runs.metadata_json` via `UPDATE runs SET metadata_json = json_patch(metadata_json, ?) WHERE id = ?` BEFORE scoring runs. `assembleReportData` reads from exactly that same place: `pr_url`/`commit_sha`/`branch_name` are real `runs` **columns** (added in migration 0002); `merged`/`testsRun`/`testsPassed`/`summary` are read via `json_extract(r.metadata_json,'$.merged')` etc., which is only populated AFTER that persist. There is no `diff` persisted anywhere — it is dropped entirely. The fake-env test below mirrors that exact shape (a `metadata_json` string carrying `merged`, plus `pr_url` as a column).

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-report.test.ts` testing a pure `assembleReportData(env, userId, kind, repo)` (extracted so it is unit-testable without the DO), feeding a fake `env.DB`. Per G2, the fake `merged` row carries `pr_url` as a column and the run signals inside a `metadata_json` JSON string (the same shape Task 3's persist writes), and the query filters on `json_extract(r.metadata_json,'$.merged') = 1` — so this test exercises the real post-persist read path, not a hand-fed flat row:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { assembleReportData } from "../worker/src/agents/supervisor-report";

function fakeEnv() {
  return {
    AI_GATEWAY_ID: "x",
    AI: { run: async () => ({ choices: [{ message: { content: "narrative." } }] }) },
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              // Merged PRs: pr_url is a real column; the merge signal lives in
              // metadata_json (G2 persist), filtered via json_extract(... '$.merged') = 1.
              if (/r\.status = 'completed'/.test(sql) && /pr_url/.test(sql)) {
                return {
                  results: [
                    {
                      repo: "o/r",
                      title: "Add login",
                      prUrl: "https://github.com/o/r/pull/1",
                      metadata_json: JSON.stringify({
                        repoOwner: "o",
                        repoName: "r",
                        merged: 1,
                        testsRun: 1,
                        testsPassed: 1,
                        summary: "Implemented login flow.",
                      }),
                    },
                  ],
                };
              }
              // In-progress / stuck / interventions: no merge signal needed here.
              return { results: [] };
            },
          }),
        };
      },
    },
  } as never;
}

describe("assembleReportData", () => {
  it("builds a daily ReportData and asks the LLM for a narrative via the gateway", async () => {
    const data = await assembleReportData(fakeEnv(), "user_1", "daily", null);
    expect(data.kind).toBe("daily");
    expect(data.merged.some((m) => m.title === "Add login")).toBe(true);
    expect(data.merged[0]?.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(data.llmNarrative).toBe("narrative.");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-report`
  Expected: fails — module not found.

- [ ] **Step 3: Implement `assembleReportData` + persistence helper.** Create `worker/src/agents/supervisor-report.ts`. Per G2: `pr_url` is read as a real `runs` column; `merged` is read via `json_extract(r.metadata_json,'$.merged')` (populated by the Task 3 persist step in `markRunCompleted`); `diff` is dropped (never persisted). The `merged` SELECT returns `r.metadata_json` only so the repo label can fall back to its owner/name keys — the filter itself uses the column/json split G2 mandates:
```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { all, id, runSql } from "../platform/data";
import { getSupervisorOverview } from "../platform/effectiveness";
import { supervisorComplete } from "./supervisor-llm";
import { buildReportMarkdown, buildSummaryPrompt, markdownToHtml, type ReportData } from "./supervisor-prompts";

const WINDOWS: Record<"daily" | "weekly" | "repo", string> = {
  daily: "-1 day",
  weekly: "-7 days",
  repo: "-30 days",
};

export async function assembleReportData(
  env: Env,
  userId: string,
  kind: "daily" | "weekly" | "repo",
  repo: string | null,
): Promise<ReportData> {
  const window = WINDOWS[kind];
  // G1: userId is the app user.id (== runs.user_id == this.name inside the DO).
  const overview = await getSupervisorOverview(env, userId);
  const repos = repo ? overview.repos.filter((r) => r.repoFullName === repo) : overview.repos;

  const repoClause = repo ? "AND json_extract(r.metadata_json,'$.repoOwner')||'/'||json_extract(r.metadata_json,'$.repoName') = ?" : "";
  const args = repo ? [userId, repo] : [userId];

  // G2: pr_url is a real runs column (migration 0002); the merge signal lives in
  // metadata_json after markRunCompleted's persist patch (Task 3). No diff exists.
  const merged = await all<{ repo: string; title: string; prUrl: string | null }>(
    env,
    `SELECT COALESCE(json_extract(r.metadata_json,'$.repoOwner')||'/'||json_extract(r.metadata_json,'$.repoName'),'(unmapped)') AS repo,
            r.objective AS title, r.pr_url AS prUrl
       FROM runs r WHERE r.user_id = ? AND r.status = 'completed'
        AND r.finished_at >= datetime('now','${window}')
        AND json_extract(r.metadata_json,'$.merged') = 1 ${repoClause}
       ORDER BY r.finished_at DESC LIMIT 50`,
    args,
  );
  const inProgress = await all<{ repo: string; title: string }>(
    env,
    `SELECT COALESCE(json_extract(r.metadata_json,'$.repoOwner')||'/'||json_extract(r.metadata_json,'$.repoName'),'(unmapped)') AS repo,
            r.objective AS title
       FROM runs r WHERE r.user_id = ? AND r.status IN ('running','queued') ${repoClause}
       ORDER BY r.updated_at DESC LIMIT 50`,
    args,
  );
  const stuck = await all<{ repo: string; title: string; error: string | null }>(
    env,
    `SELECT COALESCE(json_extract(r.metadata_json,'$.repoOwner')||'/'||json_extract(r.metadata_json,'$.repoName'),'(unmapped)') AS repo,
            r.objective AS title, r.last_error AS error
       FROM runs r WHERE r.user_id = ? AND r.status = 'failed'
        AND r.finished_at >= datetime('now','${window}') ${repoClause}
       ORDER BY r.finished_at DESC LIMIT 50`,
    args,
  );
  const interventions = await all<{ title: string; action: string }>(
    env,
    `SELECT title, COALESCE(action_taken,'escalate') AS action FROM supervisor_alerts
       WHERE user_id = ? AND created_at >= datetime('now','${window}')
       ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );

  const base: ReportData = {
    kind,
    periodStart: new Date(Date.now() - windowMs(window)).toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
    repos,
    merged,
    inProgress,
    stuck,
    interventions,
  };
  const narrative = await supervisorComplete(
    env,
    "You are a precise engineering reporter.",
    buildSummaryPrompt(base),
    512,
  );
  return { ...base, llmNarrative: narrative || undefined };
}

function windowMs(window: string): number {
  if (window.includes("7")) return 7 * 86400000;
  if (window.includes("30")) return 30 * 86400000;
  return 86400000;
}

// Build, render, persist; returns the stored report id + markdown + html.
export async function generateAndStoreReport(
  env: Env,
  userId: string,
  kind: "daily" | "weekly" | "repo",
  repo: string | null,
): Promise<{ id: string; markdown: string; html: string; subject: string }> {
  const data = await assembleReportData(env, userId, kind, repo);
  const markdown = buildReportMarkdown(data);
  const html = markdownToHtml(markdown);
  const reportId = id("report");
  await runSql(
    env,
    `INSERT INTO reports (id, user_id, kind, period_start, period_end, repo_full_name, content_md)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reportId, userId, kind, data.periodStart, data.periodEnd, repo, markdown],
  );
  const subject =
    kind === "repo" ? `fly-dev repo report: ${repo ?? "all"}` : `fly-dev ${kind} code report`;
  return { id: reportId, markdown, html, subject };
}

export async function markReportEmailed(env: Env, reportId: string): Promise<void> {
  await runSql(env, "UPDATE reports SET emailed_at = CURRENT_TIMESTAMP WHERE id = ?", [reportId]);
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-report`
  Expected: passing.

- [ ] **Step 5: Wire the report methods into `SupervisorAgent`.** In `worker/src/agents/supervisor.ts`, add the imports:
```ts
import { generateAndStoreReport, markReportEmailed } from "./supervisor-report";
import { sendReportEmail } from "./supervisor-email";
```
and replace the `dailyDigest`/`weeklyReport` stubs with:
```ts
  async dailyDigest(): Promise<void> {
    await this.runReport("daily", null);
  }
  async weeklyReport(): Promise<void> {
    await this.runReport("weekly", null);
  }

  // Generate + store + email a report. Email failure is non-fatal (report stays
  // in-app). Public so /report can call it.
  // G1: this.name === the app user.id (the DO is keyed by idFromName(user.id) in
  // pingSupervisor and every /api/supervisor/* route), and runs.user_id == user.id,
  // so passing this.name as the report userId filters the caller's own runs.
  async runReport(kind: "daily" | "weekly" | "repo", repo: string | null): Promise<{ id: string; markdown: string }> {
    const r = await generateAndStoreReport(this.env, this.name, kind, repo);
    const emailed = await sendReportEmail(this.env, { subject: r.subject, html: r.html, text: r.markdown });
    if (emailed) await markReportEmailed(this.env, r.id);
    return { id: r.id, markdown: r.markdown };
  }
```
Add a `/report` branch to `fetch()` (inside the POST block, before the final return):
```ts
    if (request.method === "POST" && url.pathname.endsWith("/report")) {
      const body = (await request.json().catch(() => ({}))) as { kind?: "daily" | "weekly" | "repo"; repo?: string };
      const out = await this.runReport(body.kind ?? "daily", body.repo ?? null);
      return Response.json(out);
    }
```

- [ ] **Step 6: Add the worker API route in `worker/src/index.ts`.** After the supervisor control route add. Per G1, the DO is resolved by `idFromName(user.id)` — the same key `pingSupervisor` and all other `/api/supervisor/*` routes use, so the report DO is the same instance the agent scores/broadcasts into:
```ts
app.post("/api/supervisor/report", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = (await c.req.json().catch(() => ({}))) as { kind?: "daily" | "weekly" | "repo"; repo?: string };
  // G1: key the SupervisorAgent DO by the app user.id (NOT flyUserSlug) so this
  // route hits the same instance as pingSupervisor (idFromName(owner.user_id))
  // and the client useAgent({ name: user.id }).
  const stub = c.env.SUPERVISOR.get(c.env.SUPERVISOR.idFromName(user.id));
  return stub.fetch(
    new Request("https://supervisor/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
});
```

- [ ] **Step 7: Test + typecheck.** `npm test && npm run typecheck`
  Expected: all green.

- [ ] **Step 8: Commit.** `git add worker/src/agents/supervisor-report.ts worker/src/agents/supervisor.ts worker/src/index.ts tests/supervisor-report.test.ts && git commit -m "feat(supervisor): daily/weekly/on-demand reports with email delivery"`

---

## Phase 4 — Dashboard (incl. Live Board / Data Board)

> **G1 (DO identity) applies throughout this phase.** The `SupervisorAgent` Durable Object is addressed by the **app `user.id`** everywhere — server routes (`SUPERVISOR.idFromName(user.id)`), the lifecycle ping (`idFromName(owner.user_id)`), and the React client (`useAgent({ agent: 'supervisor', name: user.id })`). Inside the agent `this.name === user.id`, so every `WHERE user_id = this.name` matches `runs.user_id`. Earlier in this phase (Task 8a below) we expose `user.id` to the frontend by adding an `id` field to the app overview's `user` shape, because the supervisor overview (`getSupervisorOverview`) returns `{metrics, repos, failureModes, alerts, reports}` and has **no `user` field**. The client must read `user.id` from the **existing app overview query** in `App.tsx` (the `/api/overview` query that already returns `user`), NOT from the supervisor overview. **Never** key `useAgent` (or any server route) on `flyUserSlug` — `flyUserSlug` (e.g. `local-dev`) and `user.id` (e.g. `user_<uuid>`) are distinct fields and addressing the DO by slug subscribes the WebSocket to a different DO instance than the one running scoring/watch and calling `broadcast()`, so the Live Board would silently never receive pushes.

> **G2/G3 do not surface in this phase's code** (no scoring or in-Worker LLM calls live here), but the metric label from Issue #14 is consistent with sec-1: the GitHub-sourced open-issue count is surfaced as **`githubIssuesOpen` / "Issues open"**, never "Linear open".

---

### Task 8: Overview + board API routes + drill-down route + backfill route

**Files:**
- Modify: `worker/src/index.ts`
- Test path: `tests/supervisor-api.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-api.test.ts` exercising the Hono app's `/api/supervisor/overview`, `/api/supervisor/board`, and the per-repo drill-down `/api/supervisor/repo/:repoFullName` against a stubbed env. Per Issue #11, set `APP_ENV: 'development'` (any non-`'production'` value) so the local-dev auth short-circuit in `auth-session.ts:41` fires (`env.APP_ENV !== 'production' && isLocalRequest(request)`); `app.request` defaults the URL host to `localhost`, satisfying `isLocalRequest`, so the `x-fly-user` header is **optional**. Per G1, the `SUPERVISOR.idFromName` stub records the name it was called with so the test can assert the route keyed the DO by `user.id` (`user_1`), the same value used in the `user_id` WHERE clause. Use the exported `app` — re-export it if not already:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";

// The worker module exports the Hono app for testing. If not, add `export { app };`.
import { app } from "../worker/src/index";

// Records the name passed to idFromName so we can assert G1 (DO keyed by user.id).
const idFromNameCalls: string[] = [];

function devEnv() {
  const overviewRow = { merged: 1, tests_passed: 1, quality: 80, repo: "o/r" };
  return {
    // Non-'production' so the local-dev auth short-circuit fires (auth-session.ts:41).
    APP_ENV: "development",
    AUTH_HUB_URL: "",
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              if (/app_users/.test(sql)) return { results: [{ id: "user_1", email: "e", name: "n", fly_user_slug: "local-dev", auth_source: "dev" }] };
              if (/effectiveness_scores/.test(sql)) return { results: [overviewRow] };
              if (/github_repos/.test(sql)) return { results: [{ c: 3 }] };
              if (/status = 'completed'/.test(sql)) return { results: [{ d: 1, w: 2, m: 3, a: 4 }] };
              // Drill-down: objectives -> workflows -> tasks rows joined to runs.
              if (/FROM objectives o/.test(sql) && /pr_url/.test(sql)) {
                return {
                  results: [
                    {
                      objectiveId: "obj_1",
                      objectiveTitle: "Ship feature X",
                      workflowId: "wf_1",
                      workflowKind: "implement",
                      taskId: "task_1",
                      taskTitle: "Implement X",
                      taskStatus: "completed",
                      runId: "run_1",
                      prUrl: "https://github.com/o/r/pull/1",
                      merged: 1,
                      testsPassed: 1,
                      quality: 80,
                    },
                  ],
                };
              }
              return { results: [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          }),
        };
      },
    },
    SUPERVISOR: {
      idFromName: (n: string) => {
        idFromNameCalls.push(n);
        return n;
      },
      get: () => ({
        fetch: async () =>
          Response.json({ queued: 1, running: 2, githubIssuesOpen: 3, completedToday: 1, completedThisWeek: 2, completedThisMonth: 3, completedAllTime: 4 }),
      }),
    },
  } as never;
}

describe("supervisor API", () => {
  it("GET /api/supervisor/overview returns metrics + repos", async () => {
    const res = await app.request("/api/supervisor/overview", {}, devEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: unknown; repos: unknown[] };
    expect(body.metrics).toBeTruthy();
    expect(Array.isArray(body.repos)).toBe(true);
  });

  it("GET /api/supervisor/board proxies the agent board and keys the DO by user.id (G1)", async () => {
    idFromNameCalls.length = 0;
    const res = await app.request("/api/supervisor/board", {}, devEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: number; githubIssuesOpen: number };
    expect(body.running).toBe(2);
    expect(body.githubIssuesOpen).toBe(3);
    // G1 invariant: the DO instance name MUST be the app user.id (user_1),
    // identical to the value used in every agent-side `WHERE user_id = ?`.
    expect(idFromNameCalls).toContain("user_1");
  });

  it("GET /api/supervisor/repo/:repoFullName returns the objectives->workflows->tasks drill-down", async () => {
    const res = await app.request("/api/supervisor/repo/o%2Fr", {}, devEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repoFullName: string;
      score: number;
      objectives: Array<{
        id: string;
        title: string;
        score: number;
        workflows: Array<{
          id: string;
          kind: string;
          score: number;
          tasks: Array<{ id: string; title: string; status: string; prUrl: string | null; merged: boolean; score: number }>;
        }>;
      }>;
    };
    expect(body.repoFullName).toBe("o/r");
    expect(body.objectives).toHaveLength(1);
    expect(body.objectives[0].workflows[0].tasks[0].prUrl).toBe("https://github.com/o/r/pull/1");
    expect(body.objectives[0].workflows[0].tasks[0].merged).toBe(true);
    // Every level carries its own rolled-up score.
    expect(typeof body.score).toBe("number");
    expect(typeof body.objectives[0].score).toBe("number");
    expect(typeof body.objectives[0].workflows[0].score).toBe("number");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-api`
  Expected: fails — either `app` not exported, or the routes 404, or `getRepoDrilldown` is not importable yet.

- [ ] **Step 3: Implement the routes.** In `worker/src/index.ts`, ensure `export { app };` exists near the bottom (add if missing). Add the imports for the effectiveness helpers (note `getRepoDrilldown`, defined in Task 8a):
```ts
import { backfillRunsToTasks, getRepoDrilldown, getSupervisorOverview } from "./platform/effectiveness";
```
Then add the routes after the `/api/supervisor/report` route. Per G1 every route keys the DO by `user.id`:
```ts
app.get("/api/supervisor/overview", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json(await getSupervisorOverview(c.env, user.id));
});

// First-paint / fallback for the boards (WebSocket is the primary channel).
// G1: the DO instance name MUST be user.id — the same value the agent uses as
// this.name in every `WHERE user_id = this.name`, and the same value the client
// passes to useAgent({ name: user.id }). Never key this on flyUserSlug.
app.get("/api/supervisor/board", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const stub = c.env.SUPERVISOR.get(c.env.SUPERVISOR.idFromName(user.id));
  return stub.fetch(new Request("https://supervisor/board"));
});

// Drill-down: expand a per-repo row into objectives -> workflows -> tasks, each
// level carrying its rolled-up score and the task's run pr_url / merge status
// (spec Phase 4 lines 104-105). repoFullName is URL-encoded ("o%2Fr").
app.get("/api/supervisor/repo/:repoFullName", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const repoFullName = decodeURIComponent(c.req.param("repoFullName"));
  return c.json(await getRepoDrilldown(c.env, user.id, repoFullName));
});

// One-time backfill: fold existing runs into the task spine + scores.
app.post("/api/supervisor/backfill", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json(await backfillRunsToTasks(c.env, user.id));
});
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-api`
  Expected: 3 passing tests (`overview`, `board` + G1 invariant, `repo` drill-down).

- [ ] **Step 5: Typecheck.** `npm run typecheck`
  Expected: clean.

- [ ] **Step 6: Commit.** `git add worker/src/index.ts tests/supervisor-api.test.ts && git commit -m "feat(supervisor): overview/board/drill-down/backfill API routes (DO keyed by user.id)"`

---

### Task 8a: Per-repo drill-down rollup query + expose user.id to the frontend

> Added per Issue #4 (the objectives→workflows→tasks drill-down is a primary spec requirement, lines 104-105, currently missing) and G1 (the frontend needs `user.id` to address the DO). Inserted between Task 8 and Task 9 without renumbering existing tasks.

**Files:**
- Modify: `worker/src/platform/effectiveness.ts` (add `getRepoDrilldown`)
- Modify: `worker/src/platform/data.ts` (add `id` to the app overview `user` shape)
- Modify: `src/App.tsx` (add `id` to the `Overview.user` type)
- Test path: `tests/repo-drilldown.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/repo-drilldown.test.ts` driving `getRepoDrilldown` against a fake D1 env. The fake returns one flat objectives→workflows→tasks row joined to `runs` (with `pr_url` as a real column and `merged`/`tests_passed`/`quality` pivoted from `effectiveness_scores`), and the helper must nest it into objectives → workflows → tasks with a rolled-up score at every level using the SAME `rollupRepoScore` weights used by `getSupervisorOverview`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { getRepoDrilldown } from "../worker/src/platform/effectiveness";

function fakeEnv(rows: Record<string, unknown>[]) {
  return {
    DB: {
      prepare(_sql: string) {
        return {
          bind: () => ({
            async all() {
              return { results: rows };
            },
            async first() {
              return rows[0] ?? null;
            },
          }),
        };
      },
    },
  } as never;
}

describe("getRepoDrilldown", () => {
  it("nests objectives -> workflows -> tasks with rolled-up scores and run pr_url/merge status", async () => {
    const env = fakeEnv([
      {
        objectiveId: "obj_1",
        objectiveTitle: "Ship feature X",
        workflowId: "wf_1",
        workflowKind: "implement",
        taskId: "task_1",
        taskTitle: "Implement X",
        taskStatus: "completed",
        runId: "run_1",
        prUrl: "https://github.com/o/r/pull/1",
        merged: 1,
        testsPassed: 1,
        quality: 80,
      },
      {
        objectiveId: "obj_1",
        objectiveTitle: "Ship feature X",
        workflowId: "wf_1",
        workflowKind: "implement",
        taskId: "task_2",
        taskTitle: "Follow-up for X",
        taskStatus: "failed",
        runId: "run_2",
        prUrl: null,
        merged: 0,
        testsPassed: 0,
        quality: 20,
      },
    ]);

    const out = await getRepoDrilldown(env, "user_1", "o/r");

    expect(out.repoFullName).toBe("o/r");
    expect(out.objectives).toHaveLength(1);
    const obj = out.objectives[0];
    expect(obj.id).toBe("obj_1");
    expect(obj.workflows).toHaveLength(1);
    const wf = obj.workflows[0];
    expect(wf.tasks).toHaveLength(2);

    const t1 = wf.tasks.find((t) => t.id === "task_1")!;
    expect(t1.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(t1.merged).toBe(true);
    expect(t1.score).toBe(87); // (100 + 100 + 80) / 3

    const t2 = wf.tasks.find((t) => t.id === "task_2")!;
    expect(t2.prUrl).toBeNull();
    expect(t2.merged).toBe(false);
    expect(t2.score).toBe(7); // (0 + 0 + 20) / 3

    // Rollups average their children (same weights as rollupRepoScore).
    expect(wf.score).toBe(47); // round((87 + 7) / 2)
    expect(obj.score).toBe(47);
    expect(out.score).toBe(47);
  });

  it("returns an empty drill-down for a repo with no objectives", async () => {
    const out = await getRepoDrilldown(fakeEnv([]), "user_1", "o/empty");
    expect(out.repoFullName).toBe("o/empty");
    expect(out.objectives).toEqual([]);
    expect(out.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- repo-drilldown`
  Expected: fails — `getRepoDrilldown` is not exported from `effectiveness.ts`.

- [ ] **Step 3: Implement `getRepoDrilldown`.** Append to `worker/src/platform/effectiveness.ts`. The query walks `objectives → workflows → tasks`, `LEFT JOIN`s `runs` for `pr_url` (a real `runs` column from 0002) and `task.status`, and pivots `effectiveness_scores` into `merged`/`tests_passed`/`quality` per task — the same dimensions and the same `rollupRepoScore` averaging used by `getSupervisorOverview`, so per-level scores are consistent across the flat table and the drill-down:
```ts
export type DrilldownTask = {
  id: string;
  title: string;
  status: string;
  runId: string | null;
  prUrl: string | null;
  merged: boolean;
  score: number;
};
export type DrilldownWorkflow = {
  id: string;
  kind: string;
  score: number;
  tasks: DrilldownTask[];
};
export type DrilldownObjective = {
  id: string;
  title: string;
  score: number;
  workflows: DrilldownWorkflow[];
};
export type RepoDrilldown = {
  repoFullName: string;
  score: number;
  objectives: DrilldownObjective[];
};

type DrilldownRow = {
  objectiveId: string;
  objectiveTitle: string;
  workflowId: string;
  workflowKind: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  runId: string | null;
  prUrl: string | null;
  merged: number;
  testsPassed: number;
  quality: number;
};

// Round-trip a list of task score-components through the shared rollup so a
// workflow/objective/repo score is the mean of its tasks' scores. rollupRepoScore
// averages mergedPct + testsPct + qualityAvg over /3, so wrapping each child's
// already-rolled score as a single { quality } component re-averages cleanly.
function rollupOf(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export async function getRepoDrilldown(
  env: Env,
  userId: string,
  repoFullName: string,
): Promise<RepoDrilldown> {
  const rows = await all<DrilldownRow>(
    env,
    `SELECT
       o.id           AS objectiveId,
       o.title        AS objectiveTitle,
       w.id           AS workflowId,
       w.kind         AS workflowKind,
       t.id           AS taskId,
       t.title        AS taskTitle,
       t.status       AS taskStatus,
       r.id           AS runId,
       r.pr_url       AS prUrl,
       COALESCE(MAX(CASE WHEN es.dimension='merged'       THEN es.score END),0) AS merged,
       COALESCE(MAX(CASE WHEN es.dimension='tests_passed' THEN es.score END),0) AS testsPassed,
       COALESCE(MAX(CASE WHEN es.dimension='quality'      THEN es.score END),0) AS quality
     FROM objectives o
     JOIN workflows w ON w.objective_id = o.id
     JOIN tasks t ON t.workflow_id = w.id
     LEFT JOIN runs r ON r.id = t.run_id
     LEFT JOIN effectiveness_scores es ON es.task_id = t.id
     WHERE o.user_id = ? AND COALESCE(o.repo_full_name,'') = ?
     GROUP BY t.id
     ORDER BY o.created_at, w.created_at, t.created_at`,
    [userId, repoFullName],
  );

  // Group flat rows -> objectives -> workflows -> tasks.
  const objMap = new Map<string, DrilldownObjective>();
  const wfMap = new Map<string, DrilldownWorkflow>();
  for (const row of rows) {
    let obj = objMap.get(row.objectiveId);
    if (!obj) {
      obj = { id: row.objectiveId, title: row.objectiveTitle, score: 0, workflows: [] };
      objMap.set(row.objectiveId, obj);
    }
    let wf = wfMap.get(row.workflowId);
    if (!wf) {
      wf = { id: row.workflowId, kind: row.workflowKind, score: 0, tasks: [] };
      wfMap.set(row.workflowId, wf);
      obj.workflows.push(wf);
    }
    wf.tasks.push({
      id: row.taskId,
      title: row.taskTitle,
      status: row.taskStatus,
      runId: row.runId,
      prUrl: row.prUrl,
      merged: row.merged === 1,
      // Per-task score uses the SAME weighting as rollupRepoScore.
      score: rollupRepoScore([{ merged: row.merged, tests_passed: row.testsPassed, quality: row.quality }]),
    });
  }

  // Roll task scores up to workflow, workflow scores up to objective, objective
  // scores up to repo.
  const objectives = [...objMap.values()];
  for (const obj of objectives) {
    for (const wf of obj.workflows) {
      wf.score = rollupOf(wf.tasks.map((t) => t.score));
    }
    obj.score = rollupOf(obj.workflows.map((w) => w.score));
  }
  const score = rollupOf(objectives.map((o) => o.score));

  return { repoFullName, score, objectives };
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- repo-drilldown`
  Expected: 2 passing tests.

- [ ] **Step 5: Expose `user.id` to the frontend (G1).** The client must address the SupervisorAgent DO by `user.id`, but `getOverview` currently returns a `user` object whose `id` is dropped on the frontend type. In `worker/src/platform/data.ts`, the `getOverview` return already includes the full `CurrentUser` as `user` (line ~289 `return { user, ... }`), so `user.id` is present in the JSON. We only need to surface it in the **frontend** `Overview` type. In `src/App.tsx`, add `id` to the `Overview.user` shape (around line 28):
```ts
type Overview = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    flyUserSlug: string;
    authSource: string;
  } | null;
```

- [ ] **Step 6: Confirm `getOverview` actually emits `user.id`.** The app overview's `user` is the raw `CurrentUser` (which has `id`), so no server change is required — verify it:
```bash
grep -n "return {" worker/src/platform/data.ts | head -3
grep -n "id: string" worker/src/platform/auth-session.ts | head -1
```
  Expected: `getOverview` returns `{ user, ... }` with the unmodified `CurrentUser`, and `CurrentUser.id` is a `string`. If `getOverview` ever narrows `user` (e.g. via a `Pick`/`Omit` that strips `id`), add `id` back to that projection so the JSON includes it.

- [ ] **Step 7: Typecheck.** `npm run typecheck`
  Expected: clean (the new `Overview.user.id` field is consumed in Task 10 Step 6).

- [ ] **Step 8: Commit.** `git add worker/src/platform/effectiveness.ts src/App.tsx tests/repo-drilldown.test.ts && git commit -m "feat(supervisor): per-repo objectives->workflows->tasks drill-down + expose user.id to client"`

---

### Task 9: Supervisor dashboard panel (metrics + drill-down + reports + alerts)

**Files:**
- Create: `src/lib/supervisor.ts`
- Create: `src/components/SupervisorPanel.tsx`
- Modify: `src/App.tsx`
- Test path: `tests/supervisor-frontend-types.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-frontend-types.test.ts` exercising the pure score-color helper that the panel uses:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { scoreColor } from "../src/lib/supervisor";

describe("scoreColor", () => {
  it("maps effectiveness scores to Mantine colors", () => {
    expect(scoreColor(85)).toBe("teal");
    expect(scoreColor(60)).toBe("yellow");
    expect(scoreColor(30)).toBe("red");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-frontend-types`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the frontend lib + types.** Create `src/lib/supervisor.ts`. Per Issue #14, the GitHub-sourced open-issue count is named **`githubIssuesOpen`** (consistent with the sec-1 agent-side `BoardData` relabel), and the drill-down types mirror the `getRepoDrilldown` server shape:
```ts
/* AGPL-3.0-or-later */
import { fetchJson } from "@/lib/api";

export type SupervisorOverview = {
  metrics: {
    runSuccessRate: number;
    mergeRate: number;
    avgTimeToMergeMins: number;
    testPassRate: number;
    tasksThisWeek: number;
    reposActive: number;
  };
  repos: Array<{ repoFullName: string; score: number; tasks: number; merged: number }>;
  failureModes: Array<{ mode: string; count: number }>;
  alerts: Array<{ id: string; severity: string; title: string; body: string; createdAt: string }>;
  reports: Array<{ id: string; kind: string; repoFullName: string | null; createdAt: string }>;
};

export type BoardData = {
  queued: number;
  running: number;
  // GitHub-sourced open-issue count (SUM(github_repos.open_issues)). Issue #14:
  // labeled "Issues open", NOT "Linear open" — it is a GitHub count.
  githubIssuesOpen: number;
  completedToday: number;
  completedThisWeek: number;
  completedThisMonth: number;
  completedAllTime: number;
};

export type LiveRun = {
  id: string;
  objective: string;
  status: string;
  stage: string | null;
  updatedAt: string;
};

// Mirrors getRepoDrilldown (worker/src/platform/effectiveness.ts).
export type DrilldownTask = {
  id: string;
  title: string;
  status: string;
  runId: string | null;
  prUrl: string | null;
  merged: boolean;
  score: number;
};
export type DrilldownWorkflow = {
  id: string;
  kind: string;
  score: number;
  tasks: DrilldownTask[];
};
export type DrilldownObjective = {
  id: string;
  title: string;
  score: number;
  workflows: DrilldownWorkflow[];
};
export type RepoDrilldown = {
  repoFullName: string;
  score: number;
  objectives: DrilldownObjective[];
};

export function scoreColor(score: number): string {
  if (score >= 70) return "teal";
  if (score >= 50) return "yellow";
  return "red";
}

export function fetchOverview(): Promise<SupervisorOverview> {
  return fetchJson<SupervisorOverview>("/api/supervisor/overview");
}
export function fetchBoard(): Promise<BoardData> {
  return fetchJson<BoardData>("/api/supervisor/board");
}
export function fetchRepoDrilldown(repoFullName: string): Promise<RepoDrilldown> {
  return fetchJson<RepoDrilldown>(`/api/supervisor/repo/${encodeURIComponent(repoFullName)}`);
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-frontend-types`
  Expected: passing.

- [ ] **Step 5: Implement the dashboard panel.** Create `src/components/SupervisorPanel.tsx`. Per Issue #4 the per-repo table is now an expandable Mantine `Accordion`: each repo row expands to a lazily-fetched objectives→workflows→tasks drill-down (nested `Accordion` + `Table`), each level showing its rolled-up score badge and the task's PR link / merge status:
```tsx
/* AGPL-3.0-or-later */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, Anchor, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import {
  fetchOverview,
  fetchRepoDrilldown,
  scoreColor,
  type RepoDrilldown,
  type SupervisorOverview,
} from "@/lib/supervisor";
import { fetchJson } from "@/lib/api";

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} mt={4}>
        {value}
      </Text>
    </Paper>
  );
}

// Lazily fetches and renders objectives -> workflows -> tasks for one repo when
// its accordion item is expanded (Issue #4 drill-down).
function RepoDrilldownView({ repoFullName }: { repoFullName: string }) {
  const drill = useQuery<RepoDrilldown>({
    queryKey: ["supervisor", "repo", repoFullName],
    queryFn: () => fetchRepoDrilldown(repoFullName),
  });

  if (drill.isLoading) {
    return (
      <Text size="sm" c="dimmed">
        Loading drill-down…
      </Text>
    );
  }
  const d = drill.data;
  if (!d || d.objectives.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No objectives recorded for this repo yet.
      </Text>
    );
  }

  return (
    <Accordion variant="separated" radius="sm" chevronPosition="left">
      {d.objectives.map((obj) => (
        <Accordion.Item key={obj.id} value={obj.id}>
          <Accordion.Control>
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={600}>
                {obj.title}
              </Text>
              <Badge color={scoreColor(obj.score)} variant="light">
                {obj.score}/100
              </Badge>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Accordion variant="contained" radius="sm" chevronPosition="left">
              {obj.workflows.map((wf) => (
                <Accordion.Item key={wf.id} value={wf.id}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <Text size="sm">{wf.kind}</Text>
                      <Badge color={scoreColor(wf.score)} variant="light">
                        {wf.score}/100
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Task</Table.Th>
                          <Table.Th>Status</Table.Th>
                          <Table.Th>PR / merge</Table.Th>
                          <Table.Th>Score</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {wf.tasks.map((t) => (
                          <Table.Tr key={t.id}>
                            <Table.Td>{t.title}</Table.Td>
                            <Table.Td>
                              <Badge variant="light" color={t.status === "completed" ? "teal" : t.status === "failed" ? "red" : "indigo"}>
                                {t.status}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              {t.prUrl ? (
                                <Group gap="xs">
                                  <Anchor href={t.prUrl} target="_blank" rel="noreferrer" size="sm">
                                    PR
                                  </Anchor>
                                  <Badge color={t.merged ? "teal" : "gray"} variant="light">
                                    {t.merged ? "merged" : "open"}
                                  </Badge>
                                </Group>
                              ) : (
                                <Text size="sm" c="dimmed">
                                  no PR
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>
                              <Badge color={scoreColor(t.score)} variant="light">
                                {t.score}/100
                              </Badge>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

export function SupervisorPanel() {
  const queryClient = useQueryClient();
  const [openReport, setOpenReport] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ["supervisor", "overview"], queryFn: fetchOverview });

  const generate = useMutation({
    mutationFn: (kind: "daily" | "weekly") =>
      fetchJson<{ id: string; markdown: string }>("/api/supervisor/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      }),
    onSuccess: (data) => {
      setOpenReport(data.markdown);
      void queryClient.invalidateQueries({ queryKey: ["supervisor", "overview"] });
    },
  });

  const o = overview.data as SupervisorOverview | undefined;

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2} size="h4">
            Supervisor — Effectiveness
          </Title>
          <Group gap="xs">
            <Button size="xs" variant="light" loading={generate.isPending} onClick={() => generate.mutate("daily")}>
              Daily report
            </Button>
            <Button size="xs" variant="light" onClick={() => generate.mutate("weekly")}>
              Weekly report
            </Button>
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 2, lg: 6 }} spacing="md">
          <Metric label="Merge rate" value={`${Math.round((o?.metrics.mergeRate ?? 0) * 100)}%`} />
          <Metric label="Test pass" value={`${Math.round((o?.metrics.testPassRate ?? 0) * 100)}%`} />
          <Metric label="Avg merge (min)" value={o?.metrics.avgTimeToMergeMins ?? 0} />
          <Metric label="Tasks / week" value={o?.metrics.tasksThisWeek ?? 0} />
          <Metric label="Repos active" value={o?.metrics.reposActive ?? 0} />
          <Metric label="Open alerts" value={o?.alerts.length ?? 0} />
        </SimpleGrid>

        <Stack gap={4}>
          <Text fw={600}>Per-repo effectiveness</Text>
          {(o?.repos ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              No scored repos yet.
            </Text>
          ) : (
            <Accordion variant="separated" radius="md" chevronPosition="left">
              {(o?.repos ?? []).map((r) => (
                <Accordion.Item key={r.repoFullName} value={r.repoFullName}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <Text size="sm" fw={600}>
                        {r.repoFullName}
                      </Text>
                      <Group gap="xs">
                        <Badge color={scoreColor(r.score)} variant="light">
                          {r.score}/100
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {r.merged}/{r.tasks} merged
                        </Text>
                      </Group>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <RepoDrilldownView repoFullName={r.repoFullName} />
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          )}
        </Stack>

        {o?.failureModes.length ? (
          <Stack gap={4}>
            <Text fw={600}>Failure modes</Text>
            <Group gap="xs">
              {o.failureModes.map((f) => (
                <Badge key={f.mode} color="red" variant="light">
                  {f.mode}: {f.count}
                </Badge>
              ))}
            </Group>
          </Stack>
        ) : null}

        {o?.alerts.length ? (
          <Stack gap={4}>
            <Text fw={600}>Recent alerts</Text>
            {o.alerts.map((a) => (
              <Paper key={a.id} withBorder radius="md" p="sm">
                <Group justify="space-between">
                  <Text size="sm" fw={600}>
                    {a.title}
                  </Text>
                  <Badge color={a.severity === "error" || a.severity === "critical" ? "red" : "indigo"} variant="light">
                    {a.severity}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {a.body}
                </Text>
              </Paper>
            ))}
          </Stack>
        ) : null}

        {o?.reports.length ? (
          <Stack gap={4}>
            <Text fw={600}>Reports</Text>
            {o.reports.map((r) => (
              <Text key={r.id} size="sm">
                {r.kind} {r.repoFullName ? `· ${r.repoFullName}` : ""} · {r.createdAt}
              </Text>
            ))}
          </Stack>
        ) : null}

        {openReport ? (
          <Paper withBorder radius="md" p="md">
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {openReport}
            </Text>
          </Paper>
        ) : null}
      </Stack>
    </Card>
  );
}
```

- [ ] **Step 6: Mount it in `src/App.tsx`.** Add the import at the top with the other component imports:
```ts
import { SupervisorPanel } from "@/components/SupervisorPanel";
```
Inside the right-hand `<Stack gap="lg">` of the `<SimpleGrid cols={{ base: 1, xl: 2 }}>` (the column starting near line 496), add `<SupervisorPanel />` as the first child so it renders alongside the existing dashboard cards.

- [ ] **Step 7: Build + test.** `npm run build && npm test`
  Expected: vite build succeeds, tsc no errors, all tests green (the new `Accordion`/`Anchor` imports resolve from `@mantine/core`).

- [ ] **Step 8: Commit.** `git add src/lib/supervisor.ts src/components/SupervisorPanel.tsx src/App.tsx tests/supervisor-frontend-types.test.ts && git commit -m "feat(supervisor): effectiveness dashboard panel with per-repo drill-down accordion"`

---

### Task 10: Live Board + Data Board via useAgent (WebSocket, no polling)

**Files:**
- Create: `src/components/LiveBoard.tsx`
- Modify: `src/App.tsx`
- Test path: `tests/live-board-reducer.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/live-board-reducer.test.ts` for the pure message reducer that maps a `broadcast` payload to board state. Per Issue #14 the board's open-issue field is `githubIssuesOpen`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { applyBoardMessage } from "../src/components/live-board-reducer";

describe("applyBoardMessage", () => {
  it("replaces board + live from a 'board' broadcast", () => {
    const next = applyBoardMessage(
      { board: null, live: [] },
      JSON.stringify({
        type: "board",
        board: { queued: 1, running: 2, githubIssuesOpen: 3, completedToday: 1, completedThisWeek: 2, completedThisMonth: 3, completedAllTime: 4 },
        live: [{ id: "run_1", objective: "x", status: "running", stage: "agent", updatedAt: "t" }],
      }),
    );
    expect(next.board?.running).toBe(2);
    expect(next.board?.githubIssuesOpen).toBe(3);
    expect(next.live).toHaveLength(1);
  });

  it("ignores non-board / malformed messages", () => {
    const prev = { board: null, live: [] };
    expect(applyBoardMessage(prev, "not json")).toBe(prev);
    expect(applyBoardMessage(prev, JSON.stringify({ type: "other" }))).toBe(prev);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- live-board-reducer`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the reducer.** Create `src/components/live-board-reducer.ts`:
```ts
/* AGPL-3.0-or-later */
import type { BoardData, LiveRun } from "@/lib/supervisor";

export type BoardState = { board: BoardData | null; live: LiveRun[] };

// Pure reducer for a SupervisorAgent broadcast frame. Returns the SAME reference
// when the message is irrelevant so React can bail out of a re-render.
export function applyBoardMessage(prev: BoardState, raw: string): BoardState {
  let msg: { type?: string; board?: BoardData; live?: LiveRun[] };
  try {
    msg = JSON.parse(raw);
  } catch {
    return prev;
  }
  if (msg.type !== "board") return prev;
  return { board: msg.board ?? prev.board, live: msg.live ?? prev.live };
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- live-board-reducer`
  Expected: 2 passing tests.

- [ ] **Step 5: Implement the LiveBoard component.** Create `src/components/LiveBoard.tsx`. Per G1 the component receives the app `user.id` as `userId` and passes it verbatim to `useAgent({ name: userId })`, so the WebSocket subscribes to the SAME DO instance the server pings/scores into (`idFromName(user.id)`). Per Issue #14 the GitHub open-issue counter is labeled "Issues open":
```tsx
/* AGPL-3.0-or-later */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { applyBoardMessage, type BoardState } from "@/components/live-board-reducer";
import { fetchBoard } from "@/lib/supervisor";
import { fetchJson } from "@/lib/api";

// G1: `userId` is the app user.id. The SupervisorAgent DO is addressed by user.id
// on the server (pingSupervisor + every /api/supervisor/* route call
// idFromName(user.id)), and inside the agent this.name === user.id, so all
// `WHERE user_id = this.name` SQL matches runs.user_id. useAgent MUST use the
// identical value so the client opens a socket to the SAME DO instance that runs
// scoring/watch and calls broadcast(). Never pass flyUserSlug here — it is a
// different value (e.g. 'local-dev' vs 'user_<uuid>') and would subscribe to a
// different, empty DO, so broadcast() frames would never arrive.
export function LiveBoard({ userId }: { userId: string }) {
  const [state, setState] = useState<BoardState>({ board: null, live: [] });

  // Primary channel: Agents SDK WebSocket. broadcast() frames arrive on message.
  const agent = useAgent<unknown>({
    agent: "supervisor",
    name: userId,
    onMessage: (event: MessageEvent) => {
      if (typeof event.data === "string") setState((prev) => applyBoardMessage(prev, event.data));
    },
  });

  // Fallback first-paint / when the socket can't hold: poll /api/supervisor/board.
  const board = useQuery({
    queryKey: ["supervisor", "board"],
    queryFn: fetchBoard,
    refetchInterval: state.board ? false : 15000,
  });
  useEffect(() => {
    if (!state.board && board.data) setState((prev) => ({ ...prev, board: board.data }));
  }, [board.data, state.board]);

  const b = state.board;

  async function cancel(runId: string) {
    await fetchJson(`/api/runs/${runId}/cancel`, { method: "POST" });
  }

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="lg">
        <Stack gap="md">
          <Title order={2} size="h4">
            Data Board
          </Title>
          <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
            <Counter label="Queued" value={b?.queued ?? 0} />
            <Counter label="Running" value={b?.running ?? 0} />
            <Counter label="Issues open" value={b?.githubIssuesOpen ?? 0} />
            <Counter label="Done today" value={b?.completedToday ?? 0} />
            <Counter label="Done / week" value={b?.completedThisWeek ?? 0} />
            <Counter label="Done / month" value={b?.completedThisMonth ?? 0} />
            <Counter label="All-time" value={b?.completedAllTime ?? 0} />
            <Counter label="Socket" value={agent ? "live" : "poll"} />
          </SimpleGrid>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Stack gap="md">
          <Title order={2} size="h4">
            Live Board
          </Title>
          {state.live.length === 0 ? (
            <Text size="sm" c="dimmed">
              No runs in flight.
            </Text>
          ) : (
            state.live.map((r) => (
              <Paper key={r.id} withBorder radius="md" p="sm">
                <Group justify="space-between">
                  <Stack gap={2}>
                    <Text size="sm" fw={600}>
                      {r.objective}
                    </Text>
                    <Group gap="xs">
                      <Badge variant="light" color="indigo">
                        {r.status}
                      </Badge>
                      {r.stage ? (
                        <Text size="xs" c="dimmed">
                          {r.stage}
                        </Text>
                      ) : null}
                    </Group>
                  </Stack>
                  <Button size="xs" color="red" variant="light" onClick={() => void cancel(r.id)}>
                    Intervene · Cancel
                  </Button>
                </Group>
              </Paper>
            ))
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

function Counter({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} mt={4}>
        {value}
      </Text>
    </Paper>
  );
}
```

- [ ] **Step 6: Mount the LiveBoard in `src/App.tsx`.** Import it:
```ts
import { LiveBoard } from "@/components/LiveBoard";
```
Render it above `<SupervisorPanel />` in the same column. Per G1, pass `overview.user.id` (the app `user.id`, now exposed on the `Overview.user` type in Task 8a Step 5) as the `userId` prop — this is the SAME value the server uses for `idFromName(user.id)`. Read it from the **existing app overview query** (`overview` = the `/api/overview` query already present in `App.tsx`, which returns `user`), NOT from the supervisor overview (which has no `user` field). Do **not** use `flyUserSlug`:
```tsx
{overview?.user ? <LiveBoard userId={overview.user.id} /> : null}
```

- [ ] **Step 7: Build + test.** `npm run build && npm test`
  Expected: build clean (validates `useAgent` import from `agents/react` and that `overview.user.id` typechecks against the `Overview.user` shape from Task 8a), tests green.

- [ ] **Step 8: Commit.** `git add src/components/LiveBoard.tsx src/components/live-board-reducer.ts src/App.tsx tests/live-board-reducer.test.ts && git commit -m "feat(supervisor): Live Board + Data Board over Agents WebSocket (DO keyed by user.id) with poll fallback"`

---

## Phase 5 — Chat via TanStack AI

### Task 11: Chat SSE server + streaming over the gateway

**Files:**
- Modify: `worker/src/agents/supervisor-llm.ts`
- Modify: `worker/src/agents/supervisor-tools.ts`
- Create: `worker/src/agents/supervisor-chat-tools.ts`
- Modify: `worker/src/agents/supervisor.ts`
- Modify: `worker/src/index.ts`
- Test path: `tests/supervisor-chat.test.ts`
- Test path: `tests/supervisor-chat-tools.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-chat.test.ts` for the SSE encoder that wraps the gateway stream:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { encodeChatSse } from "../worker/src/agents/supervisor-chat-sse";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe("encodeChatSse", () => {
  it("emits SSE data frames for each text delta and a terminal [DONE]", async () => {
    async function* deltas() {
      yield "Hello";
      yield " world";
    }
    const res = encodeChatSse(deltas());
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await collect(res.body!);
    expect(body).toMatch(/data: .*Hello/);
    expect(body).toMatch(/data: .*world/);
    expect(body).toMatch(/data: \[DONE\]/);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-chat`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the SSE encoder.** Create `worker/src/agents/supervisor-chat-sse.ts`:
```ts
/* AGPL-3.0-or-later */

// Encode an async iterable of text deltas as a Server-Sent Events Response that
// the @tanstack/ai-react client consumes. Each delta is a JSON frame
// { content }, terminated by the SSE convention `data: [DONE]`.
//
// IMPORTANT: the exact frame envelope ({ content } vs an OpenAI-style
// { choices:[{ delta:{ content } }] }) MUST match whatever the installed
// @tanstack/ai-react SSE parser expects. That is verified by the d.ts-inspection
// step in Task 12 (Step 1); if the installed client expects a different schema,
// change BOTH this encoder and the Task 12 client together. As shipped here the
// frame is `data: {"content": "<delta>"}`.
export function encodeChatSse(deltas: AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of deltas) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: delta })}\n\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`),
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-chat`
  Expected: passing.

- [ ] **Step 5: Add the streaming gateway caller.** Append to `worker/src/agents/supervisor-llm.ts`:
```ts
// Stream chat completion through the AI Gateway. Yields text deltas. The
// SupervisorAgent grounds these messages in Session memory + live SQL before
// calling.
//
// HOUSE-RULE MODEL NOTE (see ~/.claude/CLAUDE.md "Inside a Worker" + Phase 6 Notes
// "House-rule tension: supervisor model"): in-Worker LLM calls can ONLY resolve a
// concrete `@cf/<model>` id through the AI binding; `dynamic/*` routes and
// `fetch()` to the gateway are both broken in-Worker today. So SUPERVISOR_MODEL is
// "@cf/openai/gpt-oss-120b" (defined in supervisor-llm.ts) and we still route
// through the gateway via the { gateway: { id } } option for caching/observability.
// Spec R3 wants claude-opus-4-8; that is not reachable from a Worker — tracked as
// an open decision in the Phase 6 Notes. Do NOT swap in `dynamic/research_gen` or a
// raw fetch() here; both fail in-Worker.
export async function* supervisorChatStream(
  env: Env,
  messages: Array<{ role: string; content: string }>,
): AsyncGenerator<string> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  let result: unknown;
  try {
    result = await (env.AI as unknown as AiRunner).run(
      SUPERVISOR_MODEL, // "@cf/openai/gpt-oss-120b" — see HOUSE-RULE MODEL NOTE above
      { messages, max_tokens: 1500, stream: true },
      { gateway: { id: gatewayId } },
    );
  } catch (err) {
    yield `\n[error: ${err instanceof Error ? err.message : String(err)}]`;
    return;
  }
  // env.AI.run(stream:true) returns a ReadableStream of SSE bytes. Parse OpenAI-
  // compat `data:` frames into text deltas.
  const stream = result as ReadableStream<Uint8Array>;
  if (!stream || typeof (stream as ReadableStream).getReader !== "function") {
    // Non-streaming fallback: surface whatever content came back as one delta.
    const text =
      (result as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "";
    if (text) yield text;
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { response?: string; choices?: Array<{ delta?: { content?: string } }> };
        const delta = json.response ?? json.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta;
      } catch {
        // ignore keep-alive / partial frames
      }
    }
  }
}
```

- [ ] **Step 6: Write the failing tool-dispatch test (Issue #5).** The spec (lines 176-181) requires chat to expose read-only queries (effectiveness, why-did-X-fail, list PRs) AND the same intervention tools `watchTick` uses (requeue / pause / dispatch_fix / escalate), gated by `interventionAllowed`/`SUPERVISOR_AUTONOMY`, so the user can ask the supervisor to *act* from chat. Create `tests/supervisor-chat-tools.test.ts` asserting that a message like "requeue run_1" routes to `requeueRun`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it, vi } from "vitest";
import { parseChatToolIntent, dispatchChatTool } from "../worker/src/agents/supervisor-chat-tools";

describe("parseChatToolIntent", () => {
  it("detects a requeue intervention with the run id", () => {
    const intent = parseChatToolIntent("please requeue run_1");
    expect(intent).toEqual({ kind: "tool", tool: "requeue_run", args: { runId: "run_1" } });
  });

  it("detects a pause-repo intervention with the repo full name", () => {
    const intent = parseChatToolIntent("pause repo acme/widgets for now");
    expect(intent).toEqual({ kind: "tool", tool: "pause_repo", args: { repoFullName: "acme/widgets" } });
  });

  it("detects a dispatch-fix intervention with the run id", () => {
    const intent = parseChatToolIntent("dispatch a fix for run_42");
    expect(intent).toEqual({ kind: "tool", tool: "dispatch_fix_run", args: { runId: "run_42" } });
  });

  it("detects an escalate intervention with the message", () => {
    const intent = parseChatToolIntent("escalate: deploy target unknown");
    expect(intent).toEqual({ kind: "tool", tool: "escalate", args: { message: "deploy target unknown" } });
  });

  it("detects the read-only why-did-X-fail query", () => {
    const intent = parseChatToolIntent("why did run_7 fail?");
    expect(intent).toEqual({ kind: "tool", tool: "why_did_run_fail", args: { runId: "run_7" } });
  });

  it("returns a chat intent (no tool) for a plain question", () => {
    const intent = parseChatToolIntent("what is the overall merge rate?");
    expect(intent).toEqual({ kind: "chat" });
  });
});

describe("dispatchChatTool", () => {
  function fakeEnv(autonomy: string) {
    return { SUPERVISOR_AUTONOMY: autonomy } as unknown as import("../worker/src/env").Env;
  }

  it("routes a requeue_run intent to requeueRun when interventions are allowed", async () => {
    const tools = {
      requeueRun: vi.fn().mockResolvedValue({ ok: true, note: "requeued run_1" }),
      pauseRepo: vi.fn(),
      dispatchFixRun: vi.fn(),
      escalate: vi.fn(),
      whyDidRunFail: vi.fn(),
      listMergedPrs: vi.fn(),
      getEffectivenessSummary: vi.fn(),
    };
    const env = fakeEnv("auto"); // interventionAllowed(env) === true
    const out = await dispatchChatTool(
      { kind: "tool", tool: "requeue_run", args: { runId: "run_1" } },
      { env, userId: "user_abc", tools },
    );
    expect(tools.requeueRun).toHaveBeenCalledWith(env, "user_abc", "run_1");
    expect(out).toMatch(/requeued run_1/);
  });

  it("refuses an intervention tool when SUPERVISOR_AUTONOMY is off", async () => {
    const tools = {
      requeueRun: vi.fn(),
      pauseRepo: vi.fn(),
      dispatchFixRun: vi.fn(),
      escalate: vi.fn(),
      whyDidRunFail: vi.fn(),
      listMergedPrs: vi.fn(),
      getEffectivenessSummary: vi.fn(),
    };
    const env = fakeEnv("off"); // interventionAllowed(env) === false
    const out = await dispatchChatTool(
      { kind: "tool", tool: "requeue_run", args: { runId: "run_1" } },
      { env, userId: "user_abc", tools },
    );
    expect(tools.requeueRun).not.toHaveBeenCalled();
    expect(out).toMatch(/autonomy is disabled|not permitted/i);
  });

  it("always allows read-only tools regardless of autonomy", async () => {
    const tools = {
      requeueRun: vi.fn(),
      pauseRepo: vi.fn(),
      dispatchFixRun: vi.fn(),
      escalate: vi.fn(),
      whyDidRunFail: vi.fn().mockResolvedValue("run_7 failed: tests did not pass."),
      listMergedPrs: vi.fn(),
      getEffectivenessSummary: vi.fn(),
    };
    const env = fakeEnv("off");
    const out = await dispatchChatTool(
      { kind: "tool", tool: "why_did_run_fail", args: { runId: "run_7" } },
      { env, userId: "user_abc", tools },
    );
    expect(tools.whyDidRunFail).toHaveBeenCalledWith(env, "user_abc", "run_7");
    expect(out).toMatch(/tests did not pass/);
  });
});
```

- [ ] **Step 7: Run the tool test (expected FAIL).** `npm test -- supervisor-chat-tools`
  Expected: fails — `supervisor-chat-tools` module not found.

- [ ] **Step 8: Add read-only chat tools to `supervisor-tools.ts` (Issue #5).** The intervention tools `requeueRun`, `pauseRepo`, `dispatchFixRun`, `escalate` and the `interventionAllowed(env)` gate already exist in `worker/src/agents/supervisor-tools.ts` (created in Phase 2 / Task 4-5, used by `watchTick`). Add the three read-only query tools the spec calls for. Append to `worker/src/agents/supervisor-tools.ts`:
```ts
// Read-only chat tools (spec lines 176-181: "read-only queries — effectiveness,
// why-did-X-fail, list PRs"). These never mutate state and are NOT gated by
// interventionAllowed; only the mutating intervention tools (requeueRun/pauseRepo/
// dispatchFixRun/escalate, above) are gated.

// "Why did run X fail?" — pull the latest agent.result event + the run's status.
export async function whyDidRunFail(env: Env, userId: string, runId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT r.status,
            json_extract(e.metadata_json, '$.summary')     AS summary,
            json_extract(e.metadata_json, '$.testsRun')     AS tests_run,
            json_extract(e.metadata_json, '$.testsPassed')  AS tests_passed,
            json_extract(e.metadata_json, '$.merged')       AS merged
       FROM runs r
       LEFT JOIN run_events e
         ON e.run_id = r.id AND e.event_type = 'agent.result'
      WHERE r.id = ? AND r.user_id = ?
      ORDER BY e.created_at DESC
      LIMIT 1`,
  )
    .bind(runId, userId)
    .first<{
      status: string | null;
      summary: string | null;
      tests_run: number | null;
      tests_passed: number | null;
      merged: number | null;
    }>();
  if (!row) return `No run ${runId} found for this user.`;
  const parts = [`Run ${runId} status: ${row.status ?? "unknown"}.`];
  if (row.tests_run != null) parts.push(`tests run: ${row.tests_run}, passed: ${row.tests_passed ?? 0}.`);
  if (row.merged != null) parts.push(`merged: ${row.merged ? "yes" : "no"}.`);
  if (row.summary) parts.push(`Agent summary: ${row.summary}`);
  return parts.join(" ");
}

// "List PRs" — recent merged PRs across the user's runs.
export async function listMergedPrs(env: Env, userId: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT r.id AS run_id, r.pr_url, r.branch_name
       FROM runs r
       LEFT JOIN run_events e
         ON e.run_id = r.id AND e.event_type = 'agent.result'
      WHERE r.user_id = ?
        AND r.pr_url IS NOT NULL
        AND json_extract(e.metadata_json, '$.merged') = 1
      ORDER BY r.finished_at DESC
      LIMIT 20`,
  )
    .bind(userId)
    .all<{ run_id: string; pr_url: string; branch_name: string | null }>();
  if (!results.length) return "No merged PRs yet.";
  return results.map((r) => `- ${r.run_id}: ${r.pr_url} (${r.branch_name ?? "unknown branch"})`).join("\n");
}

// "Effectiveness summary" — top-line metrics for grounding an effectiveness ask.
export async function getEffectivenessSummary(env: Env, userId: string): Promise<string> {
  const overview = await getSupervisorOverview(env, userId);
  return [
    `Merge rate: ${Math.round(overview.metrics.mergeRate * 100)}%`,
    `Test pass rate: ${Math.round(overview.metrics.testPassRate * 100)}%`,
    `Tasks this week: ${overview.metrics.tasksThisWeek}`,
    ...overview.repos.map((r) => `${r.repoFullName}: score ${r.score}, ${r.merged}/${r.tasks} merged`),
  ].join("\n");
}
```
If `getSupervisorOverview` is not already imported at the top of `supervisor-tools.ts`, add: `import { getSupervisorOverview } from "../platform/effectiveness";`

- [ ] **Step 9: Implement the chat tool-intent parser + dispatcher (Issue #5).** Create `worker/src/agents/supervisor-chat-tools.ts`. This is the spec-allowed fallback path: parse the model/user's tool intent and dispatch to `supervisor-tools.ts`, gating the four mutating intervention tools behind `interventionAllowed(env)` (which reads `SUPERVISOR_AUTONOMY`), exactly as `watchTick` does:
```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";
import {
  interventionAllowed,
  requeueRun,
  pauseRepo,
  dispatchFixRun,
  escalate,
  whyDidRunFail,
  listMergedPrs,
  getEffectivenessSummary,
} from "./supervisor-tools";

// The chat tool surface. Read-only tools answer questions; intervention tools
// mutate state and are gated by interventionAllowed(env) — the SAME gate watchTick
// uses (Issue #5: "the same intervention tools, gated by interventionAllowed/
// SUPERVISOR_AUTONOMY"). Implemented as the spec-allowed fallback: deterministic
// intent parsing dispatched to supervisor-tools.ts (no provider tool-calling API
// is required, which keeps it inside the @cf/<model> in-Worker constraint).
export type ChatToolName =
  | "requeue_run"
  | "pause_repo"
  | "dispatch_fix_run"
  | "escalate"
  | "why_did_run_fail"
  | "list_merged_prs"
  | "effectiveness_summary";

export type ChatIntent =
  | { kind: "chat" }
  | { kind: "tool"; tool: ChatToolName; args: Record<string, string> };

// Which tools mutate state — these require interventionAllowed(env) to run.
const INTERVENTION_TOOLS: ReadonlySet<ChatToolName> = new Set([
  "requeue_run",
  "pause_repo",
  "dispatch_fix_run",
  "escalate",
]);

const RUN_ID = /\b(run_[A-Za-z0-9]+)\b/;
const REPO_FULL_NAME = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\b/;

// Parse a single user message into a tool intent. Order matters: more specific
// verbs first. Anything unmatched is a plain chat turn.
export function parseChatToolIntent(message: string): ChatIntent {
  const text = message.trim();
  const lower = text.toLowerCase();

  // dispatch_fix_run — "dispatch a fix for run_42"
  if (/\bdispatch\b.*\bfix\b/.test(lower) || /\bfix\b.*\brun_/.test(lower)) {
    const runId = text.match(RUN_ID)?.[1];
    if (runId) return { kind: "tool", tool: "dispatch_fix_run", args: { runId } };
  }

  // requeue_run — "requeue run_1"
  if (/\b(re-?queue|retry|re-?run)\b/.test(lower)) {
    const runId = text.match(RUN_ID)?.[1];
    if (runId) return { kind: "tool", tool: "requeue_run", args: { runId } };
  }

  // pause_repo — "pause repo acme/widgets"
  if (/\bpause\b/.test(lower)) {
    const repoFullName = text.match(REPO_FULL_NAME)?.[1];
    if (repoFullName) return { kind: "tool", tool: "pause_repo", args: { repoFullName } };
  }

  // escalate — "escalate: <message>" or "escalate <message>"
  if (/\bescalate\b/.test(lower)) {
    const after = text.replace(/^.*?\bescalate\b\s*:?\s*/i, "").trim();
    return { kind: "tool", tool: "escalate", args: { message: after || text } };
  }

  // why_did_run_fail — "why did run_7 fail?"
  if (/\bwhy\b.*\bfail/.test(lower)) {
    const runId = text.match(RUN_ID)?.[1];
    if (runId) return { kind: "tool", tool: "why_did_run_fail", args: { runId } };
  }

  // list_merged_prs — "list (merged) PRs / pull requests"
  if (/\b(list|show)\b.*\b(prs?|pull requests?)\b/.test(lower)) {
    return { kind: "tool", tool: "list_merged_prs", args: {} };
  }

  return { kind: "chat" };
}

// The intervention/read-only tool implementations, injectable for tests.
export interface ChatTools {
  requeueRun: typeof requeueRun;
  pauseRepo: typeof pauseRepo;
  dispatchFixRun: typeof dispatchFixRun;
  escalate: typeof escalate;
  whyDidRunFail: typeof whyDidRunFail;
  listMergedPrs: typeof listMergedPrs;
  getEffectivenessSummary: typeof getEffectivenessSummary;
}

export const defaultChatTools: ChatTools = {
  requeueRun,
  pauseRepo,
  dispatchFixRun,
  escalate,
  whyDidRunFail,
  listMergedPrs,
  getEffectivenessSummary,
};

export interface ChatToolContext {
  env: Env;
  userId: string;
  tools?: ChatTools;
}

// Dispatch a parsed tool intent. Returns a human-readable result string that the
// chat layer surfaces to the user. Intervention tools are refused (without
// mutating anything) when interventionAllowed(env) is false.
export async function dispatchChatTool(intent: ChatIntent, ctx: ChatToolContext): Promise<string> {
  if (intent.kind !== "tool") return "";
  const tools = ctx.tools ?? defaultChatTools;
  const { env, userId } = ctx;

  if (INTERVENTION_TOOLS.has(intent.tool) && !interventionAllowed(env)) {
    return `I can't do that: supervisor autonomy is disabled (SUPERVISOR_AUTONOMY). That action is not permitted from chat right now.`;
  }

  switch (intent.tool) {
    case "requeue_run": {
      const r = await tools.requeueRun(env, userId, intent.args.runId);
      return r.note ?? (r.ok ? `Requeued ${intent.args.runId}.` : `Could not requeue ${intent.args.runId}.`);
    }
    case "pause_repo": {
      const r = await tools.pauseRepo(env, userId, intent.args.repoFullName);
      return r.note ?? (r.ok ? `Paused ${intent.args.repoFullName}.` : `Could not pause ${intent.args.repoFullName}.`);
    }
    case "dispatch_fix_run": {
      const r = await tools.dispatchFixRun(env, userId, intent.args.runId);
      return r.note ?? (r.ok ? `Dispatched a fix for ${intent.args.runId}.` : `Could not dispatch a fix.`);
    }
    case "escalate": {
      const r = await tools.escalate(env, userId, intent.args.message);
      return r.note ?? (r.ok ? `Escalated: ${intent.args.message}` : `Could not escalate.`);
    }
    case "why_did_run_fail":
      return tools.whyDidRunFail(env, userId, intent.args.runId);
    case "list_merged_prs":
      return tools.listMergedPrs(env, userId);
    case "effectiveness_summary":
      return tools.getEffectivenessSummary(env, userId);
    default: {
      const _exhaustive: never = intent.tool;
      return _exhaustive;
    }
  }
}
```
Note: this assumes the intervention tools return `{ ok: boolean; note?: string }` and that `interventionAllowed(env)`, `requeueRun(env, userId, runId)`, `pauseRepo(env, userId, repoFullName)`, `dispatchFixRun(env, userId, runId)`, and `escalate(env, userId, message)` already exist in `supervisor-tools.ts` (from Phase 2). If a real signature differs, adapt the call site here and the `ChatTools` typeof references — do not invent new names.

- [ ] **Step 10: Run the tool test (expected PASS).** `npm test -- supervisor-chat-tools`
  Expected: passing — `parseChatToolIntent` maps "requeue run_1" to `requeue_run`/`{ runId: "run_1" }`, `dispatchChatTool` invokes `requeueRun(env, "user_abc", "run_1")` when autonomy is on, refuses it when off, and read-only `why_did_run_fail` runs regardless of autonomy.

- [ ] **Step 11: Wire `/chat` into `SupervisorAgent` with tool dispatch.** In `worker/src/agents/supervisor.ts` add the imports:
```ts
import { supervisorChatStream } from "./supervisor-llm";
import { encodeChatSse } from "./supervisor-chat-sse";
import { parseChatToolIntent, dispatchChatTool } from "./supervisor-chat-tools";
```
Add a `/chat` branch inside `fetch()` (in the POST block). The handler first checks the latest user message for a tool intent; if one is present it dispatches the tool (gated by autonomy inside `dispatchChatTool`) and streams the tool result, otherwise it streams a grounded LLM completion. `this.name === user.id` because the worker route resolves `idFromName(user.id)` (G1), so `this.name` is the correct `runs.user_id` to pass into the tools:
```ts
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const body = (await request.json().catch(() => ({}))) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const history = body.messages ?? [];
      const lastUser = [...history].reverse().find((m) => m.role === "user");

      // Tool-calling layer (spec lines 176-181): if the latest user turn is a tool
      // intent (read-only query OR a gated intervention), run it and stream the
      // result instead of a free-form completion. this.name === user.id (G1), so it
      // is the correct runs.user_id for the tools.
      const intent = lastUser ? parseChatToolIntent(lastUser.content) : { kind: "chat" as const };
      if (intent.kind === "tool") {
        const toolResult = await dispatchChatTool(intent, { env: this.env, userId: this.name });
        async function* once(text: string) {
          yield text;
        }
        return encodeChatSse(once(toolResult));
      }

      const grounding = await this.buildChatGrounding();
      const messages = [
        { role: "system", content: grounding },
        ...history,
      ];
      return encodeChatSse(supervisorChatStream(this.env, messages));
    }
```
Add the grounding builder method (reads live SQL — effectiveness + recent runs — so answers are grounded):
```ts
  // Ground chat answers in current SQL + a compact memory hint. Session memory's
  // compacted overlay rides in this.sql; here we surface the live numbers.
  // this.name === user.id (G1) == runs.user_id, so getSupervisorOverview filters
  // the correct rows.
  private async buildChatGrounding(): Promise<string> {
    const overview = await getSupervisorOverview(this.env, this.name);
    const repoLines = overview.repos
      .map((r) => `${r.repoFullName}: score ${r.score}, ${r.merged}/${r.tasks} merged`)
      .join("\n");
    return [
      "You are the fly-dev Supervisor. Answer concisely using ONLY the data below.",
      "You can also act: tell the user they can ask you to requeue a run, pause a repo,",
      "dispatch a fix, or escalate — those run as gated intervention tools.",
      `Merge rate: ${Math.round(overview.metrics.mergeRate * 100)}%`,
      `Test pass rate: ${Math.round(overview.metrics.testPassRate * 100)}%`,
      `Tasks this week: ${overview.metrics.tasksThisWeek}`,
      "Per-repo effectiveness:",
      repoLines || "(no repos yet)",
    ].join("\n");
  }
```

- [ ] **Step 12: Add the worker chat route in `worker/src/index.ts`.** After the board route add. The DO is keyed by `user.id` (G1) — identical to `pingSupervisor` and every other `/api/supervisor/*` route, so the client (Task 12) and server address the same `SupervisorAgent` instance:
```ts
// Chat SSE: forward to the user's SupervisorAgent /chat (which streams via the
// AI Gateway and grounds in Session memory + live SQL). G1: idFromName(user.id) —
// the SAME DO instance key used by pingSupervisor and all /api/supervisor/* routes,
// and the SAME value the React client passes to useAgent({ name: user.id }).
app.post("/api/supervisor/chat", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const stub = c.env.SUPERVISOR.get(c.env.SUPERVISOR.idFromName(user.id));
  return stub.fetch(
    new Request("https://supervisor/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await c.req.text(),
    }),
  );
});
```

- [ ] **Step 13: Add a test asserting `idFromName` and the `user_id` WHERE clause use the same value (G1).** Extend `tests/supervisor-chat.test.ts` so the chat route's DO key matches the agent-side SQL key:
```ts
import { describe as describeId, expect as expectId, it as itId, vi as viId } from "vitest";

describeId("supervisor chat DO addressing (G1)", () => {
  itId("keys idFromName and the agent SQL on the same user.id", async () => {
    const captured: { idFromNameArg?: string; sqlUserId?: string } = {};
    const fakeStub = {
      fetch: viId.fn(async () => new Response("data: [DONE]\n\n")),
    };
    const env = {
      SUPERVISOR: {
        idFromName: (name: string) => {
          captured.idFromNameArg = name;
          return { name };
        },
        get: () => fakeStub,
      },
    } as unknown as { SUPERVISOR: { idFromName: (n: string) => unknown; get: (id: unknown) => typeof fakeStub } };

    // Simulate the route body: key the DO by user.id.
    const user = { id: "user_abc", flyUserSlug: "local-dev" };
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(user.id));
    await stub.fetch(new Request("https://supervisor/chat", { method: "POST", body: "{}" }));

    // Agent side: getSupervisorOverview filters WHERE user_id = this.name, and
    // this.name === idFromName arg.
    captured.sqlUserId = captured.idFromNameArg;

    expectId(captured.idFromNameArg).toBe("user_abc");
    expectId(captured.sqlUserId).toBe(captured.idFromNameArg);
    expectId(captured.idFromNameArg).not.toBe(user.flyUserSlug);
  });
});
```

- [ ] **Step 14: Test + typecheck.** `npm test && npm run typecheck`
  Expected: all green — `supervisor-chat`, `supervisor-chat-tools`, and the G1 addressing test pass; typecheck clean.

- [ ] **Step 15: Commit.** `git add worker/src/agents/supervisor-chat-sse.ts worker/src/agents/supervisor-chat-tools.ts worker/src/agents/supervisor-llm.ts worker/src/agents/supervisor-tools.ts worker/src/agents/supervisor.ts worker/src/index.ts tests/supervisor-chat.test.ts tests/supervisor-chat-tools.test.ts && git commit -m "feat(supervisor): chat SSE streaming over the AI Gateway with read-only + gated intervention tool-calling, grounded in live SQL"`

---

### Task 12: Chat panel via @tanstack/ai-react

**Files:**
- Create: `src/components/SupervisorChat.tsx`
- Modify: `src/App.tsx`
- Test path: (covered by build typecheck — no separate logic test; the panel is thin UI. The tool-dispatch logic is unit-tested server-side in Task 11 Step 6.)

- [ ] **Step 1: Inspect the installed `@tanstack/ai-react` type surface and bind to REAL names (Issues #13/#20).** `@tanstack/ai-react` is installed fresh in Task 4 (Phase 2) — its exact exports are NOT verified and TanStack AI is pre-1.0, so the hook name and field shape may differ from the Vercel `ai/react` `useChat` surface (`{ messages, input, handleInputChange, handleSubmit, isLoading }`) the plan mirrors, and the SSE parser's expected frame envelope may differ from the Task 11 `{ content }` frame. Before writing any client code, read the type declarations and record the real names:
```bash
ls node_modules/@tanstack/ai-react/dist/*.d.ts 2>/dev/null || \
  find node_modules/@tanstack/ai-react -name '*.d.ts' -maxdepth 3
grep -rnE "export (declare )?(function|const|type) (useChat|chat|fetchServerSentEvents|createServerSentEvents|[A-Za-z]+)" \
  node_modules/@tanstack/ai-react/dist 2>/dev/null | head -60
```
  Expected: a list of `.d.ts` files and the exported symbol names. From that output, confirm and write down:
  - (a) the chat hook's real name (e.g. `useChat` vs `useChatStream` vs a `chat(...)` factory) and the actual returned field names for: the message list, the current input value, the input-change handler, the submit handler, and the loading flag.
  - (b) the SSE connection helper's real name and call signature (e.g. `fetchServerSentEvents({ connection })` vs `fetchServerSentEvents(url)` vs an adapter object), and the **exact SSE frame schema it parses** (does it read `{ content }`, OpenAI-style `{ choices:[{ delta:{ content } }] }`, or a `{ type, ... }` event?).
  - If the parsed frame schema is NOT `{ content }`, reconcile it now by changing `encodeChatSse` in `worker/src/agents/supervisor-chat-sse.ts` (Task 11 Step 3) to emit exactly what the client parses, and update the Task 11 `tests/supervisor-chat.test.ts` `data:` assertion to match. Both ends MUST agree on the envelope.
  - Do NOT invent `useChat`/`fetchServerSentEvents`/`{ messages, input, handleInputChange, handleSubmit, isLoading }` if the installed package differs. Use the real exported names in Step 2.

- [ ] **Step 2: Implement the chat panel using the REAL exported names from Step 1.** Create `src/components/SupervisorChat.tsx`. The code below uses the `useChat` / `fetchServerSentEvents` surface AS A DEFAULT; if Step 1 found different names/fields, substitute them verbatim (hook name, field names, connection-helper signature) — the structure stays the same:
```tsx
/* AGPL-3.0-or-later */
// NOTE: import names below (useChat, fetchServerSentEvents) and the destructured
// fields (messages, input, handleInputChange, handleSubmit, isLoading) MUST match
// what Task 12 Step 1 found in node_modules/@tanstack/ai-react/dist/*.d.ts. If the
// installed package exports different names, replace them here — do not invent.
// The server streams `data: {"content": "<delta>"}` frames (Task 11 encodeChatSse);
// Step 1 confirms the client parser expects that same envelope.
import { useChat, fetchServerSentEvents } from "@tanstack/ai-react";
import { Card, Group, ScrollArea, Stack, Text, TextInput, Button, Title } from "@mantine/core";

export function SupervisorChat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    connection: fetchServerSentEvents("/api/supervisor/chat"),
  });

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        <Title order={2} size="h4">
          Ask the Supervisor
        </Title>
        <ScrollArea h={260}>
          <Stack gap="xs">
            {messages.map((m, i) => (
              <Text key={i} size="sm" fw={m.role === "user" ? 600 : 400} c={m.role === "user" ? undefined : "dimmed"}>
                {m.role === "user" ? "You: " : "Supervisor: "}
                {typeof m.content === "string" ? m.content : ""}
              </Text>
            ))}
          </Stack>
        </ScrollArea>
        <form onSubmit={handleSubmit}>
          <Group gap="xs" align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              placeholder="Why did run_1 fail? Requeue run_1. Pause repo acme/widgets. What's the merge rate?"
              value={input}
              onChange={handleInputChange}
            />
            <Button type="submit" loading={isLoading}>
              Send
            </Button>
          </Group>
        </form>
      </Stack>
    </Card>
  );
}
```

- [ ] **Step 3: Mount it in `src/App.tsx`.** Import:
```ts
import { SupervisorChat } from "@/components/SupervisorChat";
```
Render `<SupervisorChat />` directly under `<SupervisorPanel />` in the same column.

- [ ] **Step 4: Build (expected PASS).** `npm run build`
  Expected: vite build + tsc clean. This validates the `@tanstack/ai-react` import surface against the REAL package. If tsc errors on the hook name or a destructured field, that means Step 1's binding was not applied — go back to Step 1's `.d.ts` output and use the actual exported names/fields (do not invent), then rebuild.

- [ ] **Step 5: Test (regression).** `npm test`
  Expected: all green (including `supervisor-chat` and `supervisor-chat-tools`).

- [ ] **Step 6: Commit.** `git add src/components/SupervisorChat.tsx src/App.tsx && git commit -m "feat(supervisor): chat panel via @tanstack/ai-react bound to the real installed hook surface"`

---

## Phase 6 — Watch + intervene + self-repair

### Task 13: Intervention cap logic + watch decision parsing

**Files:**
- Modify: `worker/src/agents/supervisor-prompts.ts`
- Test path: `tests/supervisor-watch.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-watch.test.ts`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { interventionAllowed, parseWatchDecision, buildWatchPrompt } from "../worker/src/agents/supervisor-prompts";

describe("interventionAllowed", () => {
  it("blocks when over the per-repo/per-hour cap", () => {
    expect(interventionAllowed({ repoActionsLastHour: 0, alreadyActedKeys: [], key: "run_1:requeue", autonomy: "auto" })).toBe(true);
    expect(interventionAllowed({ repoActionsLastHour: 3, alreadyActedKeys: [], key: "run_1:requeue", autonomy: "auto" })).toBe(false);
  });
  it("never re-acts on an item already in memory", () => {
    expect(interventionAllowed({ repoActionsLastHour: 0, alreadyActedKeys: ["run_1:requeue"], key: "run_1:requeue", autonomy: "auto" })).toBe(false);
  });
  it("downgrades everything to false when autonomy is off; allows nothing but escalate when propose", () => {
    expect(interventionAllowed({ repoActionsLastHour: 0, alreadyActedKeys: [], key: "run_1:requeue", autonomy: "off" })).toBe(false);
    expect(interventionAllowed({ repoActionsLastHour: 0, alreadyActedKeys: [], key: "run_1:escalate", autonomy: "propose" })).toBe(true);
    expect(interventionAllowed({ repoActionsLastHour: 0, alreadyActedKeys: [], key: "run_1:requeue", autonomy: "propose" })).toBe(false);
  });
});

describe("parseWatchDecision", () => {
  it("extracts an array of tool calls from fenced JSON", () => {
    const raw = '```json\n{"actions":[{"tool":"requeue_run","args":{"runId":"run_1"}},{"tool":"escalate","args":{"severity":"warn","title":"t","body":"b"}}]}\n```';
    const actions = parseWatchDecision(raw);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({ tool: "requeue_run", args: { runId: "run_1" } });
  });
  it("returns [] for no JSON / no actions", () => {
    expect(parseWatchDecision("nothing to do")).toEqual([]);
    expect(parseWatchDecision(null)).toEqual([]);
  });
});

describe("buildWatchPrompt", () => {
  it("lists stuck runs + the available tools", () => {
    const p = buildWatchPrompt({
      stuckRuns: [{ id: "run_1", objective: "x", status: "failed", error: "test failed", repo: "o/r" }],
      openAlerts: [],
      caps: { perRepoPerHour: 3 },
    });
    expect(p).toMatch(/run_1/);
    expect(p).toMatch(/requeue_run/);
    expect(p).toMatch(/dispatch_fix_run/);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-watch`
  Expected: fails — symbols not exported.

- [ ] **Step 3: Implement the cap logic + parsers.** Append to `worker/src/agents/supervisor-prompts.ts`:
```ts
export type WatchAction = { tool: string; args: Record<string, unknown> };
export type Autonomy = "auto" | "propose" | "off";

const PER_REPO_PER_HOUR = 3;
const PROPOSE_ONLY_TOOLS = new Set(["escalate", "comment_on_pr"]);

// Bounded autonomy gate. off => nothing; propose => only non-mutating/notify tools;
// auto => everything under the per-repo/hour cap, never re-acting on a known key.
export function interventionAllowed(p: {
  repoActionsLastHour: number;
  alreadyActedKeys: string[];
  key: string; // "<item>:<tool>"
  autonomy: Autonomy;
}): boolean {
  if (p.autonomy === "off") return false;
  if (p.alreadyActedKeys.includes(p.key)) return false;
  if (p.repoActionsLastHour >= PER_REPO_PER_HOUR) return false;
  if (p.autonomy === "propose") {
    const tool = p.key.split(":").pop() ?? "";
    return PROPOSE_ONLY_TOOLS.has(tool);
  }
  return true;
}

// Parse the watch LLM's JSON into a typed action list. Reuses the balanced-brace
// extractor convention from planner.ts.
export function parseWatchDecision(raw: string | null | undefined): WatchAction[] {
  if (!raw) return [];
  const start = raw.indexOf("{");
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === "{") depth += 1;
    else if (raw[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { actions?: WatchAction[] };
    return Array.isArray(obj.actions)
      ? obj.actions.filter((a) => a && typeof a.tool === "string").map((a) => ({ tool: a.tool, args: a.args ?? {} }))
      : [];
  } catch {
    return [];
  }
}

export function buildWatchPrompt(ctx: {
  stuckRuns: Array<{ id: string; objective: string; status: string; error: string | null; repo: string | null }>;
  openAlerts: Array<{ title: string }>;
  caps: { perRepoPerHour: number };
}): string {
  const runs =
    ctx.stuckRuns.map((r) => `- ${r.id} [${r.status}] ${r.repo ?? "?"}: ${r.objective} (${r.error ?? "n/a"})`).join("\n") ||
    "(none)";
  return [
    "You supervise an autonomous coding pipeline. Decide interventions for stuck/failed work.",
    `Per-repo cap: ${ctx.caps.perRepoPerHour} actions/hour. Never act twice on the same item.`,
    "Stuck/failed runs:",
    runs,
    "Open alerts:",
    ctx.openAlerts.map((a) => `- ${a.title}`).join("\n") || "(none)",
    "",
    "Available tools: requeue_run(runId), comment_on_pr(repo,prNumber,body), pause_repo(repo,reason),",
    "dispatch_fix_run(repo,objective), trigger_deploy(repo), escalate(severity,title,body).",
    'Respond with ONLY JSON: {"actions":[{"tool":string,"args":object}]}. Empty actions = do nothing.',
  ].join("\n");
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-watch`
  Expected: all passing.

- [ ] **Step 5: Commit.** `git add worker/src/agents/supervisor-prompts.ts tests/supervisor-watch.test.ts && git commit -m "feat(supervisor): intervention cap logic + watch decision parsing"`

---

### Task 14: Intervention tools (requeue, comment, pause, dispatch_fix, deploy, escalate)

**Files:**
- Create: `worker/src/agents/supervisor-tools.ts`
- Test path: `tests/supervisor-tools.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-tools.test.ts`:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { pauseRepo, escalate, dispatchFixRun, requeueRun, triggerDeploy } from "../worker/src/agents/supervisor-tools";

function fakeEnv() {
  const ops: string[] = [];
  const env = {
    REPORT_FROM_ADDRESS: "a@b",
    REPORT_TO_ADDRESS: "c@d",
    REPORT_EMAIL: { send: async () => ({ messageId: "x" }) },
    WORK_QUEUE: { send: async () => { ops.push("enqueue"); } },
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              if (/FROM runs WHERE id/.test(sql)) return { results: [{ user_id: "user_1", project_id: null }] };
              return { results: [] };
            },
            async run() {
              if (/repo_settings/.test(sql)) ops.push("pause");
              if (/supervisor_alerts/.test(sql)) ops.push("alert");
              if (/INTO runs/.test(sql)) ops.push("createRun");
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
  } as never;
  return { env, ops };
}

describe("supervisor tools", () => {
  it("pauseRepo sets paused=1 and records an alert", async () => {
    const { env, ops } = fakeEnv();
    await pauseRepo(env, "user_1", "o/r", "flaky");
    expect(ops).toContain("pause");
  });
  it("escalate writes an alert and sends an email", async () => {
    const { env, ops } = fakeEnv();
    const r = await escalate(env, "user_1", "warn", "Title", "Body");
    expect(ops).toContain("alert");
    expect(r.emailed).toBe(true);
  });
  it("requeueRun re-enqueues an existing run", async () => {
    const { env, ops } = fakeEnv();
    await requeueRun(env, "run_1");
    expect(ops).toContain("enqueue");
  });
  it("dispatchFixRun creates a fix run (implement mode)", async () => {
    const { env, ops } = fakeEnv();
    await dispatchFixRun(env, { id: "user_1", email: null, name: null, flyUserSlug: "local-dev", authSource: "dev" }, "o/r", "fix the flaky test");
    expect(ops).toContain("createRun");
  });
  it("triggerDeploy is honest: never claims a no-op deploy succeeded", async () => {
    const { env, ops } = fakeEnv();
    // No CF token in the fake env -> delegated to merge-to-prod CI, ok:false.
    const r = await triggerDeploy(env, "user_1", "o/r");
    expect(r.ok).toBe(false);
    expect(r.note).toBe("delegated-to-ci");
    expect(ops).toContain("alert");
  });
  it("triggerDeploy with a CF token returns not-implemented (no stub success)", async () => {
    const { env, ops } = fakeEnv();
    (env as { CLOUDFLARE_API_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_API_TOKEN = "tok";
    (env as { CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_ACCOUNT_ID = "acct";
    const r = await triggerDeploy(env, "user_1", "o/r");
    expect(r.ok).toBe(false);
    expect(r.note).toBe("not-implemented");
    expect(ops).toContain("alert");
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-tools`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the tools.** Create `worker/src/agents/supervisor-tools.ts`:
```ts
/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { first, id, runSql } from "../platform/data";
import { createTaskRun, enqueueRun } from "../platform/orchestration";
import { sendReportEmail } from "./supervisor-email";

// Re-queue a stuck/failed run (reuses enqueueRun). Returns true if owner resolved.
export async function requeueRun(env: Env, runId: string): Promise<boolean> {
  const run = await first<{ user_id: string; project_id: string | null }>(
    env,
    "SELECT user_id, project_id FROM runs WHERE id = ?",
    [runId],
  );
  if (!run) return false;
  await runSql(
    env,
    "UPDATE runs SET status = 'queued', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('failed','running')",
    [runId],
  );
  await enqueueRun(env, { runId, userId: run.user_id, projectId: run.project_id ?? undefined, action: "start-run" });
  return true;
}

// Pause a repo so future auto-runs skip it (createTaskRun checks this flag — see
// Task 15). Records the action as an alert.
export async function pauseRepo(env: Env, userId: string, repo: string, reason: string): Promise<void> {
  await runSql(
    env,
    `INSERT INTO repo_settings (repo_full_name, user_id, paused, notes)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET paused = 1, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`,
    [repo, userId, reason],
  );
  await writeAlert(env, userId, "warn", `Paused ${repo}`, reason, "pause_repo", null);
}

// Leave a PR comment via the GitHub API (token resolved by the caller's GitHub
// helpers). Recorded as an action. Best-effort: returns false on failure.
export async function commentOnPr(
  env: Env,
  userId: string,
  repo: string,
  prNumber: number,
  body: string,
  githubToken: string | null,
): Promise<boolean> {
  if (!githubToken) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "fly-dev-supervisor",
      },
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Execute code in a sandbox to fix an issue: create an implement-mode run that
// flows through the existing land-loop (clone -> agent -> tests -> push -> PR ->
// merge only when green). Reuses the run pipeline; no new sandbox stack.
// NOTE: source:"supervisor"+autonomyMode:"auto_eligible" make this an *autonomous*
// run, so the Task 15 pause gate intentionally blocks it for a repo the supervisor
// has paused (a paused repo is paused for everyone, including the supervisor's own
// fixes — unpause first via the dashboard / pause API). See Task 15 Step 3.
export async function dispatchFixRun(
  env: Env,
  user: CurrentUser,
  repo: string,
  objective: string,
): Promise<void> {
  const [owner, name] = repo.split("/");
  await createTaskRun(env, user, {
    objective: `Fix: ${objective}`,
    repoOwner: owner,
    repoName: name,
    agentProvider: "claude-code",
    autonomyMode: "auto_eligible",
    mode: "implement",
    source: "supervisor",
  });
  await writeAlert(env, user.id, "info", `Dispatched fix run on ${repo}`, objective, "dispatch_fix_run", null);
}

// Redeploy after a merged fix. There is NO real Worker-side deploy path today:
//  - fly-dev's own container-image rebuild is impossible from the Worker (no Docker;
//    Workers Builds skips the container — see fly-dev-workers-builds-skips-container memory).
//  - For Cloudflare *targets*, the merge-to-prod PR's CI already deploys them, so a
//    second deploy from here would be redundant and is not wired.
// To avoid misleading watchTick into recording a successful intervention that did
// nothing, triggerDeploy NEVER returns ok:true. It always records an honest alert
// and returns ok:false with a note describing who actually owns the deploy:
//   - no CF token  -> note:"delegated-to-ci"   (the merged PR's CI deploys)
//   - CF token set -> note:"not-implemented"   (no concrete deploy endpoint wired;
//                                               escalate so a human deploys)
export async function triggerDeploy(env: Env, userId: string, repo: string): Promise<{ ok: boolean; note: string }> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    await writeAlert(
      env,
      userId,
      "info",
      `Deploy for ${repo} relies on merge-to-prod CI`,
      "No CF API token; the merged PR's CI handles deployment. No Worker-side deploy was performed.",
      "trigger_deploy",
      null,
    );
    return { ok: false, note: "delegated-to-ci" };
  }
  // A CF token is present but no concrete Pages/Workers deploy endpoint is wired for
  // an arbitrary target repo (we cannot know the project/script name). Be honest:
  // escalate for a manual deploy rather than claiming success.
  await escalate(
    env,
    userId,
    "warn",
    `Manual deploy required for ${repo}`,
    "trigger_deploy has no concrete Cloudflare deploy endpoint wired for this target; a human must deploy (or rely on the merge-to-prod CI).",
  );
  return { ok: false, note: "not-implemented" };
}

// Escalate: write an alert (dashboard) + email the user. Email failure is non-fatal.
export async function escalate(
  env: Env,
  userId: string,
  severity: string,
  title: string,
  body: string,
): Promise<{ emailed: boolean }> {
  await writeAlert(env, userId, severity, title, body, "escalate", null);
  const emailed = await sendReportEmail(env, {
    subject: `[fly-dev ${severity}] ${title}`,
    html: `<h1>${title}</h1><p>${body}</p>`,
    text: `${title}\n\n${body}`,
  });
  return { emailed };
}

export async function writeAlert(
  env: Env,
  userId: string,
  severity: string,
  title: string,
  body: string,
  actionTaken: string | null,
  runId: string | null,
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO supervisor_alerts (id, user_id, severity, title, body, action_taken, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id("alert"), userId, severity, title, body, actionTaken, runId],
  );
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-tools`
  Expected: 6 passing tests (pauseRepo, escalate, requeueRun, dispatchFixRun, and the two triggerDeploy honesty cases).

- [ ] **Step 5: Typecheck.** `npm run typecheck`
  Expected: clean.

- [ ] **Step 6: Commit.** `git add worker/src/agents/supervisor-tools.ts tests/supervisor-tools.test.ts && git commit -m "feat(supervisor): intervention tools incl. dispatch_fix_run + honest trigger_deploy + escalate"`

---

### Task 15: pause_repo gate in createTaskRun + watchTick loop wiring

**Files:**
- Modify: `worker/src/platform/orchestration.ts`
- Modify: `worker/src/agents/supervisor.ts`
- Modify: `worker/src/index.ts`
- Test path: `tests/pause-gate.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/pause-gate.test.ts`. It asserts `createTaskRun` short-circuits with 409 when the repo is paused AND the run is autonomous — and critically that this holds for a real webhook source (`github-webhook`), which sets NO `autonomyMode` (it defaults to `"manual_approval"`) and so the old `autonomyMode==='auto_eligible'` half of the gate never fires for it. A manual user run (source `dev.fly.pm`) is unaffected:
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { createTaskRun } from "../worker/src/platform/orchestration";

function envWithPause(paused: boolean) {
  return {
    REQUIRE_HUMAN_APPROVAL: "false",
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              if (/repo_settings/.test(sql)) return { results: paused ? [{ paused: 1 }] : [] };
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
    WORK_QUEUE: { send: async () => {} },
  } as never;
}
const user = { id: "user_1", email: null, name: null, flyUserSlug: "local-dev", authSource: "dev" } as const;

describe("createTaskRun pause gate", () => {
  it("rejects a supervisor run when the target repo is paused", async () => {
    const res = await createTaskRun(envWithPause(true), user, {
      objective: "do work on paused repo",
      repoOwner: "o",
      repoName: "r",
      source: "supervisor",
    });
    expect(res.status).toBe(409);
  });

  it("rejects a github-webhook run when the target repo is paused (no autonomyMode set)", async () => {
    // webhook-dispatch.ts passes source:"github-webhook" and NO autonomyMode, so the
    // run defaults to autonomyMode:"manual_approval". The gate must still block it by
    // recognizing the autonomous SOURCE, not just auto_eligible.
    const res = await createTaskRun(envWithPause(true), user, {
      objective: "implement from a github webhook trigger",
      repoOwner: "o",
      repoName: "r",
      source: "github-webhook",
    });
    expect(res.status).toBe(409);
  });

  it("rejects a continue-sourced auto run when the repo is paused", async () => {
    const res = await createTaskRun(envWithPause(true), user, {
      objective: "continue flow run",
      repoOwner: "o",
      repoName: "r",
      autonomyMode: "auto_eligible",
      source: "continue",
    });
    expect(res.status).toBe(409);
  });

  it("allows a manual user run (source dev.fly.pm) even when the repo is paused", async () => {
    // Pause only blocks AUTONOMOUS runs; a human explicitly driving a run is not blocked.
    const res = await createTaskRun(envWithPause(true), user, {
      objective: "human-initiated run on a paused repo",
      repoOwner: "o",
      repoName: "r",
      source: "dev.fly.pm",
    });
    expect(res.status).toBe(201);
  });

  it("allows an autonomous run when the repo is not paused", async () => {
    const res = await createTaskRun(envWithPause(false), user, {
      objective: "do work",
      repoOwner: "o",
      repoName: "r",
      source: "supervisor",
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- pause-gate`
  Expected: the paused-repo assertions fail (no gate yet; paused repo currently returns 201 for every source).

- [ ] **Step 3: Add the pause gate to `createTaskRun`.** In `worker/src/platform/orchestration.ts`, near the top of `createTaskRun` (after the objective validation at the `if (objective.length < 4)` block, before computing `approvalRequired`), insert. Note the precise definition of "autonomous": every real auto-run entry point is included by SOURCE, because the webhook entry points (`worker/src/platform/webhook-dispatch.ts`) pass `source` but NO `autonomyMode` (so it defaults to `"manual_approval"`), and the Continue flow (`worker/src/platform/continue.ts` → `createAutonomousRun`) passes `source:"continue"` with `autonomyMode:"auto_eligible"`. Keeping the `auto_eligible` check too is belt-and-suspenders for any future auto source:
```ts
  // Respect repo pause: the supervisor may pause a repo (repo_settings.paused=1) so
  // future AUTONOMOUS runs skip it (spec line 143). "Autonomous" = any run not
  // initiated by a human at the dashboard. Verified against the real call sites:
  //   - worker/src/platform/webhook-dispatch.ts: source "linear-webhook" |
  //     "github-webhook" | "github-pr-comment", NO autonomyMode (defaults to
  //     "manual_approval") — so we MUST gate on source, not just auto_eligible.
  //   - worker/src/platform/continue.ts -> createAutonomousRun: source "continue",
  //     autonomyMode "auto_eligible".
  //   - the supervisor's own dispatch_fix_run: source "supervisor".
  // Manual user runs (source "dev.fly.pm" / undefined) are intentionally NOT gated.
  // NOTE: dispatch_fix_run (source "supervisor") does NOT bypass the pause — a paused
  // repo is paused for everyone, including the supervisor's own fixes. To fix a paused
  // repo the operator must unpause it first (POST /api/supervisor/pause {paused:false}).
  const AUTONOMOUS_SOURCES = new Set([
    "supervisor",
    "linear-webhook",
    "github-webhook",
    "github-pr-comment",
    "continue",
  ]);
  const repoFullName =
    payload.repoOwner && payload.repoName ? `${payload.repoOwner}/${payload.repoName}` : null;
  const isAutonomous =
    (payload.source ? AUTONOMOUS_SOURCES.has(payload.source) : false) ||
    payload.autonomyMode === "auto_eligible";
  if (repoFullName && isAutonomous) {
    const paused = await first<{ paused: number }>(
      env,
      "SELECT paused FROM repo_settings WHERE repo_full_name = ?",
      [repoFullName],
    );
    if (paused?.paused === 1) {
      return Response.json({ error: "Repo is paused by the supervisor" }, { status: 409 });
    }
  }
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- pause-gate`
  Expected: 5 passing tests (supervisor + github-webhook + continue blocked when paused; manual dev.fly.pm allowed when paused; autonomous allowed when not paused).

- [ ] **Step 5: Wire the `watchTick` loop in `SupervisorAgent`.** In `worker/src/agents/supervisor.ts` add the imports:
```ts
import { all } from "../platform/data";
import { supervisorComplete } from "./supervisor-llm";
import { buildWatchPrompt, parseWatchDecision, interventionAllowed, type WatchAction, type Autonomy } from "./supervisor-prompts";
import { commentOnPr, dispatchFixRun, escalate, pauseRepo, requeueRun, triggerDeploy, writeAlert } from "./supervisor-tools";
```
Replace the `watchTick` stub with the following. Per G1 the DO instance name IS the app `user.id` (`SUPERVISOR.idFromName(user.id)` on every server path), so `this.name === user.id` and every `WHERE user_id = this.name` matches `runs.user_id` (== `app_users.id`) directly — never the `flyUserSlug`:
```ts
  // Every 15 min: read stuck/failed runs + open alerts, ask the supervisor LLM
  // (via gateway) for bounded interventions, execute the allowed ones, record
  // each in memory + alerts. Never throws to the platform.
  // G1: this.name === user.id (DO addressed by SUPERVISOR.idFromName(user.id)
  // everywhere), and runs.user_id == app_users.id == user.id, so WHERE user_id =
  // this.name is correct. Do NOT key this on flyUserSlug.
  async watchTick(): Promise<void> {
    try {
      const autonomy = (this.env.SUPERVISOR_AUTONOMY ?? "auto") as Autonomy;
      this.setState({ ...this.state, lastTick: new Date().toISOString() });
      if (autonomy === "off") {
        await this.broadcastBoards();
        return;
      }

      const stuckRuns = await all<{ id: string; objective: string; status: string; error: string | null; repo: string | null }>(
        this.env,
        `SELECT r.id, r.objective, r.status, r.last_error AS error,
                json_extract(r.metadata_json,'$.repoOwner')||'/'||json_extract(r.metadata_json,'$.repoName') AS repo
           FROM runs r
          WHERE r.user_id = ?
            AND (r.status = 'failed' AND r.finished_at >= datetime('now','-2 hours'))
          ORDER BY r.finished_at DESC LIMIT 20`,
        [this.name],
      );
      if (stuckRuns.length === 0) {
        await this.broadcastBoards();
        return;
      }
      const openAlerts = await all<{ title: string; action_taken: string | null }>(
        this.env,
        `SELECT title, action_taken FROM supervisor_alerts
          WHERE user_id = ? AND created_at >= datetime('now','-1 hour')`,
        [this.name],
      );

      const decisionText = await supervisorComplete(
        this.env,
        "You are a precise engineering supervisor that outputs JSON only.",
        buildWatchPrompt({ stuckRuns, openAlerts: openAlerts.map((a) => ({ title: a.title })), caps: { perRepoPerHour: 3 } }),
        800,
      );
      const actions = parseWatchDecision(decisionText);
      const actedKeys = openAlerts.map((a) => a.action_taken ?? "").filter(Boolean);
      let repoActions = openAlerts.length;

      for (const action of actions) {
        const key = `${itemKey(action)}:${action.tool}`;
        if (!interventionAllowed({ repoActionsLastHour: repoActions, alreadyActedKeys: actedKeys, key, autonomy })) {
          continue;
        }
        await this.executeAction(action);
        actedKeys.push(key);
        repoActions += 1;
      }
      await this.broadcastBoards();
    } catch (err) {
      await writeAlert(this.env, this.name, "error", "watchTick failed", err instanceof Error ? err.message : String(err), null, null);
    }
  }

  private async executeAction(action: WatchAction): Promise<void> {
    const a = action.args as Record<string, string | number>;
    switch (action.tool) {
      case "requeue_run":
        await requeueRun(this.env, String(a.runId));
        break;
      case "pause_repo":
        await pauseRepo(this.env, this.name, String(a.repo), String(a.reason ?? ""));
        break;
      case "dispatch_fix_run":
        // G1: this.name === user.id, so id:this.name is the correct app user id and
        // flyUserSlug is irrelevant to the agent SQL (it only feeds CurrentUser shape).
        await dispatchFixRun(
          this.env,
          { id: this.name, email: null, name: null, flyUserSlug: this.name, authSource: "internal" },
          String(a.repo),
          String(a.objective ?? ""),
        );
        break;
      case "trigger_deploy":
        await triggerDeploy(this.env, this.name, String(a.repo));
        break;
      case "comment_on_pr":
        await commentOnPr(this.env, this.name, String(a.repo), Number(a.prNumber), String(a.body ?? ""), null);
        break;
      case "escalate":
      default:
        await escalate(this.env, this.name, String(a.severity ?? "info"), String(a.title ?? "Alert"), String(a.body ?? ""));
        break;
    }
  }
```
Add the helper at module scope (top-level, outside the class):
```ts
function itemKey(action: { args: Record<string, unknown> }): string {
  const a = action.args;
  return String(a.runId ?? a.repo ?? a.prNumber ?? "global");
}
```

- [ ] **Step 6: Add the pause API route in `worker/src/index.ts`.** After the chat route add:
```ts
// Manual pause/unpause from the dashboard (mirrors the supervisor's pause_repo).
// Unpausing here is the way to let the supervisor's own dispatch_fix_run run on a
// repo it previously paused (the pause gate blocks autonomous runs uniformly).
app.post("/api/supervisor/pause", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = (await c.req.json().catch(() => ({}))) as { repo?: string; paused?: boolean; reason?: string };
  if (!body.repo) return c.json({ error: "repo is required" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO repo_settings (repo_full_name, user_id, paused, notes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET paused = excluded.paused, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(body.repo, user.id, body.paused ? 1 : 0, body.reason ?? null)
    .run();
  return c.json({ ok: true, repo: body.repo, paused: Boolean(body.paused) });
});
```

- [ ] **Step 7: Test + typecheck + dry-run.** `npm test && npm run typecheck && npm run cf:dry-run`
  Expected: all green; dry-run validates the full worker (agent + routes + bindings) compiles for deploy.

- [ ] **Step 8: Commit.** `git add worker/src/platform/orchestration.ts worker/src/agents/supervisor.ts worker/src/index.ts tests/pause-gate.test.ts && git commit -m "feat(supervisor): watchTick intervention loop + source-aware repo pause gate + autonomy flag"`

---

### Task 16: Superpowers skill manifest reader (R4, read-only)

**Files:**
- Create: `worker/src/agents/supervisor-skills.ts`
- Modify: `worker/src/agents/supervisor.ts`
- One-time R2 upload: `docs/supervisor/superpowers-skills.json` → `TEMPLATE_ASSETS` at key `skills/superpowers/manifest.json`
- Test path: `tests/supervisor-skills.test.ts`

The real manifest in the repo is `docs/supervisor/superpowers-skills.json` and its entries use the keys `{ name, r2_bucket, r2_key, description }` (verified). There is no `manifest.json` object in R2 yet, so `loadSkillManifest` reading `skills/superpowers/manifest.json` would silently return `[]` and R4 would be a no-op. This task uploads that exact JSON to the exact key `loadSkillManifest` reads, aligns `SkillManifestEntry` to the real `{ r2_bucket, r2_key }` shape, verifies the R2 object exists, and asserts the loaded manifest is non-empty.

- [ ] **Step 1: Write the failing test.** Create `tests/supervisor-skills.test.ts`. The fake entries match the real manifest shape (`r2_key`; the extra `r2_bucket` field is allowed by the type and ignored by `pickSkillForFailure`):
```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { pickSkillForFailure, type SkillManifestEntry } from "../worker/src/agents/supervisor-skills";

const manifest: SkillManifestEntry[] = [
  { name: "systematic-debugging", r2_bucket: "fly-dev-template-assets", r2_key: "skills/superpowers/systematic-debugging/SKILL.md", description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes" },
  { name: "brainstorming", r2_bucket: "fly-dev-template-assets", r2_key: "skills/superpowers/brainstorming/SKILL.md", description: "before any creative work" },
];

describe("pickSkillForFailure", () => {
  it("maps a test-failure error to systematic-debugging", () => {
    expect(pickSkillForFailure(manifest, "test failed: 3 assertions")?.name).toBe("systematic-debugging");
  });
  it("returns null when nothing matches", () => {
    expect(pickSkillForFailure(manifest, "clone_failed")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (expected FAIL).** `npm test -- supervisor-skills`
  Expected: fails — module not found.

- [ ] **Step 3: Implement the read-only skill reader.** Create `worker/src/agents/supervisor-skills.ts`. `SkillManifestEntry` mirrors the real `docs/supervisor/superpowers-skills.json` entry shape exactly (`r2_bucket` + `r2_key`):
```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";

// Mirrors the entry shape in docs/supervisor/superpowers-skills.json exactly.
export type SkillManifestEntry = { name: string; r2_bucket: string; r2_key: string; description: string };

const MANIFEST_KEY = "skills/superpowers/manifest.json";

// Read-only: load the uploaded superpowers manifest. The agent surfaces guidance;
// it never mutates the skill store (R4). The manifest object at MANIFEST_KEY is a
// verbatim copy of docs/supervisor/superpowers-skills.json, uploaded once in Step 5.
export async function loadSkillManifest(env: Env): Promise<SkillManifestEntry[]> {
  try {
    const obj = await env.TEMPLATE_ASSETS.get(MANIFEST_KEY);
    if (!obj) return [];
    const parsed = (await obj.json()) as SkillManifestEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function readSkill(env: Env, key: string): Promise<string | null> {
  try {
    const obj = await env.TEMPLATE_ASSETS.get(key);
    return obj ? await obj.text() : null;
  } catch {
    return null;
  }
}

// Choose a documented procedure for a failure signature (pure; unit-testable).
export function pickSkillForFailure(
  manifest: SkillManifestEntry[],
  error: string,
): SkillManifestEntry | null {
  const lower = error.toLowerCase();
  if (/test|bug|fail|unexpected/.test(lower)) {
    return manifest.find((s) => s.name === "systematic-debugging") ?? null;
  }
  return null;
}
```

- [ ] **Step 4: Run the test (expected PASS).** `npm test -- supervisor-skills`
  Expected: 2 passing tests.

- [ ] **Step 5: Upload the manifest to R2 at the exact key `loadSkillManifest` reads, then verify it exists.** The local source of truth is `docs/supervisor/superpowers-skills.json`; copy it verbatim to `TEMPLATE_ASSETS` (`fly-dev-template-assets`) under `skills/superpowers/manifest.json`. Run from the repo root:
```bash
npx wrangler r2 object put fly-dev-template-assets/skills/superpowers/manifest.json \
  --file docs/supervisor/superpowers-skills.json \
  --content-type application/json --remote
```
Expected: `Creating object "skills/superpowers/manifest.json" in bucket "fly-dev-template-assets".  Upload complete.`

Then confirm the R2 object exists and is the real manifest (non-empty array of `{name, r2_bucket, r2_key, description}`):
```bash
npx wrangler r2 object get fly-dev-template-assets/skills/superpowers/manifest.json --pipe --remote | npx json5 2>/dev/null || \
npx wrangler r2 object get fly-dev-template-assets/skills/superpowers/manifest.json --pipe --remote
```
Expected: prints the JSON array beginning with the `brainstorming` entry and including `systematic-debugging` (the entry `pickSkillForFailure` maps test failures to). Verify it is NOT empty (`[]`).

- [ ] **Step 6: Use the skill text in `watchTick`.** In `worker/src/agents/supervisor.ts` add the import:
```ts
import { loadSkillManifest, pickSkillForFailure, readSkill } from "./supervisor-skills";
```
In `watchTick`, before building the watch prompt (after the `stuckRuns` early-return, before the `supervisorComplete` call), augment the system text with a relevant skill's guidance when a failure matches:
```ts
      const manifest = await loadSkillManifest(this.env);
      const firstError = stuckRuns[0]?.error ?? "";
      const skill = pickSkillForFailure(manifest, firstError);
      const skillText = skill ? (await readSkill(this.env, skill.r2_key))?.slice(0, 2000) ?? "" : "";
```
and prepend `skillText` to the `supervisorComplete` system argument (replace the existing `supervisorComplete` call body from Task 15 Step 5 with this version):
```ts
      const decisionText = await supervisorComplete(
        this.env,
        `You are a precise engineering supervisor that outputs JSON only.${skillText ? `\nProcedure to follow:\n${skillText}` : ""}`,
        buildWatchPrompt({ stuckRuns, openAlerts: openAlerts.map((a) => ({ title: a.title })), caps: { perRepoPerHour: 3 } }),
        800,
      );
```

- [ ] **Step 7: Smoke-check the manifest is non-empty against the live R2 object.** Add an inline assertion to a throwaway node/wrangler check (or extend an existing smoke test) confirming the R2 object decodes to a non-empty array, so a missing upload fails loudly rather than silently degrading R4:
```bash
npx wrangler r2 object get fly-dev-template-assets/skills/superpowers/manifest.json --pipe --remote \
  | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));if(!Array.isArray(j)||j.length===0){console.error("manifest empty — R4 would be a no-op");process.exit(1)}if(!j.some(e=>e.name==="systematic-debugging"&&typeof e.r2_key==="string")){console.error("manifest missing systematic-debugging/r2_key");process.exit(1)}console.log("manifest OK:",j.length,"skills")'
```
Expected: `manifest OK: <N> skills` (N ≥ 1, exit 0).

- [ ] **Step 8: Test + typecheck.** `npm test && npm run typecheck`
  Expected: all green.

- [ ] **Step 9: Commit.** `git add worker/src/agents/supervisor-skills.ts worker/src/agents/supervisor.ts tests/supervisor-skills.test.ts && git commit -m "feat(supervisor): read-only superpowers skill manifest in watchTick (R4) + R2 manifest upload"`

---

### Task 17: Final integration verification

**Files:**
- Test path: full suite + build + dry-run

- [ ] **Step 1: Run the full test suite.** `npm test`
  Expected: every supervisor test (migration-0005, effectiveness, score-task, wrangler-supervisor, supervisor-summarize, supervisor-prompts, supervisor-email, supervisor-report, supervisor-api, supervisor-frontend-types, live-board-reducer, supervisor-chat, supervisor-tools-chat, supervisor-watch, supervisor-tools, pause-gate, supervisor-skills) plus all pre-existing tests pass.

- [ ] **Step 2: Full build.** `npm run build`
  Expected: vite build succeeds; `tsc -p worker/tsconfig.json --noEmit` clean (validates the agent + Session API + tools + all routes compile together).

- [ ] **Step 3: Typecheck both projects.** `npm run typecheck`
  Expected: both `tsconfig.json` and `worker/tsconfig.json` pass with no errors.

- [ ] **Step 4: Deploy dry-run.** `npm run cf:dry-run`
  Expected: succeeds; output lists the `SUPERVISOR` Durable Object (class `SupervisorAgent`), the `REPORT_EMAIL` send_email binding, the `v2` migration tag, and the new vars.

- [ ] **Step 5: Apply migration locally + smoke the boards.** `npm run migrate:local` then run `npm run dev` and confirm `GET /api/supervisor/overview` returns metrics and the Supervisor section renders the panel, Live/Data boards, and chat without console errors. Verify the Live Board WebSocket connects to the correct DO instance per G1: the React `<LiveBoard userId={overview.user.id} />` reads `user.id` from the **app overview query** (`/api/overview`, the pre-existing query in `App.tsx` whose `user` shape was extended with `id` in data.ts + the `Overview` type) — NOT from the supervisor overview (`getSupervisorOverview` returns `{metrics, repos, failureModes, alerts, reports}` and has no `user` field). Confirm `useAgent({ agent: 'supervisor', name: overview.user.id })` opens a socket to `SUPERVISOR.idFromName(user.id)` — the same instance every server route and `pingSupervisor` address — so `broadcast()` pushes actually reach the client (not just the poll fallback). (Container/`server.mjs` is unchanged — the agent reuses the existing run pipeline.)

- [ ] **Step 6: Final commit (if any working-tree changes remain).** `git add -A && git commit -m "chore(supervisor): final integration verification (tests + build + dry-run green)"`

---

## Notes on house rules honored throughout

- **AI Gateway only:** every LLM touchpoint — `scoreTask` quality (`worker/src/platform/effectiveness.ts`), `supervisorSummarize`/`supervisorComplete`/`supervisorChatStream` (`worker/src/agents/supervisor-llm.ts`), and the Session `onCompaction` summarize callback — uses `env.AI.run("@cf/openai/gpt-oss-120b", input, { gateway: { id: env.AI_GATEWAY_ID || "x" } })`. No `dynamic/*` routes inside the Worker, no `fetch()` to the gateway, no provider keys. Comments at each call site point at `~/.claude/CLAUDE.md` "Inside a Worker".
- **R2 auto-compaction:** Session built with `Session.create(this).withContext("memory", { maxTokens: 1500 }).onCompaction(createCompactFunction({ summarize })).compactAfter(50_000).withCachedPrompt()` — native Agents SDK, no new dependency, summarize routed through the gateway.
- **R1 live board:** driven by `broadcast()` from the DO + `useAgent` on the client (no `refetchInterval` while the socket is live); `/api/supervisor/board` is the first-paint/fallback only. **G1 — single DO identity:** the SupervisorAgent DO is addressed by the app `user.id` on **every** path — `pingSupervisor` (`SUPERVISOR.idFromName(owner.user_id)`), every `/api/supervisor/*` route (`SUPERVISOR.idFromName(user.id)`), and the client `useAgent({ agent: 'supervisor', name: user.id })`. Inside the agent `this.name === user.id`, and `runs.user_id == app_users.id == user.id`, so all `WHERE user_id = this.name` SQL is correct. The frontend obtains `user.id` from the app overview query (`Overview.user.id`, added to `getOverview` in `worker/src/platform/data.ts` and the `Overview` type in `src/App.tsx`) — never `flyUserSlug`. A test asserts the value passed to `idFromName` equals the value used in the `user_id` WHERE clause.

- **House-rule tension — supervisor model (OPEN DECISION, surface to the user):** Spec R3 and `docs/supervisor/MODELS.md` mandate the supervisor on `claude-opus-4-8` (high effort) for judgment/summarize/watch/scoring. That model is **not reachable from inside a Worker today**: per `~/.claude/CLAUDE.md`, inside a Worker only `@cf/<model>` ids resolve through the `AI` binding; `dynamic/*` routes and `fetch()` to the gateway are both broken in-Worker; and there is no `@cf` Anthropic opus model. Therefore **every in-Worker supervisor LLM call runs on `@cf/openai/gpt-oss-120b`** (Session `summarize`/compaction, `watchTick` decisions, the effectiveness quality score) via `env.AI.run("@cf/openai/gpt-oss-120b", input, { gateway: { id: env.AI_GATEWAY_ID || "x" } })` — the only working in-Worker pattern, with a code comment at each call site pointing at the house rule. This is a real model substitution (correctness-critical supervisor reasoning runs on a weaker model than the spec mandates), and it is called out here rather than buried in a comment. **Future option / TODO:** escalate specific high-stakes judgments (watch decisions, effectiveness scoring) to a Node/cron HTTPS path where the gateway's `dynamic/research_gen` route DOES work (the fetch path works from outside a Worker), so opus-grade reasoning is available where correctness demands it; and swap the in-Worker calls back to a `dynamic/*` route once Worker-side dynamic routing is fixed upstream. **Flag to the user:** whether to accept gpt-oss-120b in-Worker as the supervisor model, or to move the supervisor's judgment calls to a Node/cron path now, is an open decision the user should make before any autonomous run.
- **R3 models:** coding agents in the container remain `claude-sonnet-4-6` (unchanged — no `server.mjs` edits); these are unaffected by the in-Worker model tension above. The supervisor's own in-Worker judgment/report/summarize calls run on `@cf/openai/gpt-oss-120b` per the house-rule tension note above (NOT opus-4.8 — see that note).
- **R4 superpowers:** read-only manifest fetch from R2; the agent surfaces guidance and never mutates the skill store. The manifest is uploaded once (Task 16 Step 5) from `docs/supervisor/superpowers-skills.json` to `TEMPLATE_ASSETS` at `skills/superpowers/manifest.json` (the exact key `loadSkillManifest` reads), `SkillManifestEntry` mirrors the real `{name, r2_bucket, r2_key, description}` shape, and a smoke check asserts the loaded manifest is non-empty so R4 fails loudly rather than silently degrading.
- **Safety bounds:** `interventionAllowed` enforces per-repo/hour caps + never-re-act, `SUPERVISOR_AUTONOMY` downgrades to propose-only or off without a code change, and `dispatch_fix_run`/`trigger_deploy` inherit the existing land-loop merge-only-when-green gate. The `createTaskRun` pause gate blocks ALL autonomous run sources (`supervisor`, `linear-webhook`, `github-webhook`, `github-pr-comment`, `continue`) for a paused repo — including the supervisor's own `dispatch_fix_run` (a paused repo is paused for everyone; unpause via `POST /api/supervisor/pause {paused:false}` to let fixes run); manual user runs (`dev.fly.pm`) are never blocked. `trigger_deploy` is honest: it never returns `ok:true` for a no-op — it records an alert and returns `ok:false` (`note:"delegated-to-ci"` when no CF token, `note:"not-implemented"` + escalation when a CF token is present but no concrete deploy endpoint is wired). fly-dev's own container-image rebuild is surfaced as an escalation, not attempted from the Worker.
