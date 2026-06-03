# Autonomous "Continue" + GitHub repos reclaim/harden — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub repos show in the UI again (and self-heal), then add a per-project "Continue" button that reviews a Linear project, asks an LLM for next steps, creates Linear issues, and autonomously starts runs.

**Architecture:** Worker (Hono on Cloudflare) + D1 + React/Mantine SPA. New worker modules `planner.ts` and `continue.ts` orchestrate the Continue flow; `linear.ts` gains issue-creation; `orchestration.ts` gains an autonomous run path that reuses the existing create+approve transitions; `data.ts` gains a one-time user-data reclaim. The LLM call routes through Cloudflare AI Gateway using the sanctioned worker-side `env.AI.run("@cf/...", { gateway })` pattern.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/D1/Workflows/Queues, Drizzle (schema only), React 19, @tanstack/react-query, Mantine, vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-continue-button-and-repos-fix-design.md`

**Conventions:** alias imports (`@/…`) in `src/`, relative imports in `worker/`; files camelCase; tests in `tests/*.test.ts` importing the module under test directly; run all tests with `npm test`, a single file with `npx vitest run tests/<file>`; `npm run typecheck` must stay green.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/api.ts` | (modify) surface server `error` text on failed requests |
| `worker/src/env.ts` | (modify) add `CONTINUE_AUTONOMY`, `CONTINUE_EXECUTE_CAP` |
| `wrangler.jsonc` | (modify) default values for the two new vars |
| `worker/src/platform/data.ts` | (modify) `reclaimUserData()` |
| `worker/src/platform/planner.ts` | (new) `extractJsonPlan()` + `planNextSteps()` |
| `worker/src/platform/linear.ts` | (modify) `resolveProjectTeam()`, `createLinearIssue()` |
| `worker/src/platform/orchestration.ts` | (modify) `createAutonomousRun()` |
| `worker/src/platform/continue.ts` | (new) `selectExecuteTargets()` + `continueProject()` |
| `worker/src/index.ts` | (modify) routes: continue, reclaim; harden `/api/overview` |
| `src/App.tsx` | (modify) Continue button + result panel; repos Sync affordance + error surfacing |
| `tests/planner.test.ts` | (new) plan JSON extraction |
| `tests/linear.test.ts` | (new) issue-create / team-resolve request shapes |
| `tests/continue.test.ts` | (new) `selectExecuteTargets` selection logic |
| `tests/reclaim.test.ts` | (new) idempotent fold |

---

## Task 1: Surface server error text in `fetchJson`

`fetchJson` currently throws `Request failed with <status>`, hiding the server's
`{ error }` message (e.g. "No GitHub repo mapped…"). Make it use the body's `error`
when present. Used by every mutation, so the Continue/Sync error UX depends on it.

**Files:**
- Modify: `src/lib/api.ts:14-16`

- [ ] **Step 1: Replace the error branch**

In `src/lib/api.ts`, replace:

```ts
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
```

with:

```ts
  if (!response.ok) {
    let detail = `Request failed with ${response.status}`;
    try {
      const body = (await response.clone().json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON body — keep the status-based default
    }
    throw new Error(detail);
  }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "fix(ui): surface server error text on failed requests"
```

---

## Task 2: Add `CONTINUE_AUTONOMY` + `CONTINUE_EXECUTE_CAP` env vars

**Files:**
- Modify: `worker/src/env.ts:91` (end of `Env` type)
- Modify: `wrangler.jsonc:149-161` (`vars`)

- [ ] **Step 1: Add the fields to the `Env` type**

In `worker/src/env.ts`, immediately after the line `CLAUDE_CODE_OAUTH_TOKEN?: string;` add:

```ts
  // Continue flow. CONTINUE_AUTONOMY="true" lets the Continue button auto-approve
  // runs, bypassing REQUIRE_HUMAN_APPROVAL (operator opt-in). CONTINUE_EXECUTE_CAP
  // caps how many runs one Continue click starts. Both are non-secret vars.
  CONTINUE_AUTONOMY?: string;
  CONTINUE_EXECUTE_CAP?: string;
```

- [ ] **Step 2: Add defaults to `wrangler.jsonc` vars**

In `wrangler.jsonc`, inside `"vars"`, after the `"AUTH_HUB_URL": "https://auth.fly.pm"` line add a comma and:

```jsonc
    "CONTINUE_AUTONOMY": "true",
    "CONTINUE_EXECUTE_CAP": "3"
```

(Ensure the preceding line ends with a comma and the object stays valid JSON.)

- [ ] **Step 3: Validate config + types**

Run: `npm run typecheck && npx wrangler deploy --dry-run --outdir /tmp/fly-dev-dryrun 2>&1 | tail -5`
Expected: typecheck PASS; dry-run completes without a config parse error (it may warn about bindings; a clean parse of `wrangler.jsonc` is what we're checking).

- [ ] **Step 4: Commit**

```bash
git add worker/src/env.ts wrangler.jsonc
git commit -m "feat(continue): add CONTINUE_AUTONOMY and CONTINUE_EXECUTE_CAP vars"
```

---

## Task 3: `reclaimUserData()` — fold orphaned user-scoped rows

**Files:**
- Modify: `worker/src/platform/data.ts` (append new exported function)
- Test: `tests/reclaim.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/reclaim.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { reclaimUserData } from "../worker/src/platform/data";

// Minimal recording fake of the D1 surface reclaimUserData uses
// (env.DB.prepare(sql).bind(...).run() -> { meta: { changes } }).
function fakeEnv(changesByTable: Record<string, number>) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() {
              calls.push({ sql, binds });
              const table = /(?:UPDATE|DELETE FROM)\s+(\w+)/.exec(sql)?.[1] ?? "";
              return { meta: { changes: changesByTable[table] ?? 0 } };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

describe("reclaimUserData", () => {
  it("re-points user-scoped tables and drops legacy connections", async () => {
    const { env, calls } = fakeEnv({
      github_repos: 274,
      runs: 5,
      usage_events: 12,
      agent_memories: 0,
      account_connections: 4,
    });

    const result = await reclaimUserData(env, "user_canon");

    expect(result).toEqual({
      repos: 274,
      runs: 5,
      usage: 12,
      memories: 0,
      connectionsDropped: 4,
    });
    // every statement targets the canonical user and excludes it from the WHERE
    for (const call of calls) {
      expect(call.binds).toContain("user_canon");
    }
    expect(calls.some((c) => /UPDATE github_repos/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM account_connections/.test(c.sql))).toBe(true);
  });

  it("is a no-op on re-run (nothing left to fold)", async () => {
    const { env } = fakeEnv({});
    const result = await reclaimUserData(env, "user_canon");
    expect(result).toEqual({
      repos: 0,
      runs: 0,
      usage: 0,
      memories: 0,
      connectionsDropped: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reclaim.test.ts`
Expected: FAIL — `reclaimUserData` is not exported from `data.ts`.

- [ ] **Step 3: Implement `reclaimUserData`**

Append to `worker/src/platform/data.ts` (end of file):

```ts
// One-time, idempotent reconciliation: fold every OTHER user's user-scoped rows
// into `intoUserId`. The Wave 1 auth migration minted a new app_users row for the
// same human, orphaning repos/runs/usage under the old id (see the 2026-06-02
// spec). Re-pointable tables are UPDATEd; account_connections cannot be re-pointed
// (UNIQUE(user_id, provider)) so legacy duplicates are deleted (the canonical user
// keeps its own). Idempotent: a second run matches no rows. Single-operator tool —
// this collapses all identities into one; do not use as-is for true multi-tenancy.
export async function reclaimUserData(
  env: Env,
  intoUserId: string,
): Promise<{ repos: number; runs: number; usage: number; memories: number; connectionsDropped: number }> {
  const repos = await repointUser(env, "github_repos", intoUserId);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/reclaim.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/data.ts tests/reclaim.test.ts
git commit -m "feat(data): reclaimUserData to fold orphaned user-scoped rows"
```

---

## Task 4: `planner.ts` — extract a plan from model output + call the gateway

**Files:**
- Create: `worker/src/platform/planner.ts`
- Test: `tests/planner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/planner.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { extractJsonPlan, planNextSteps } from "../worker/src/platform/planner";

describe("extractJsonPlan", () => {
  it("parses a fenced json block with reasoning preamble", () => {
    const raw =
      "Let me think... here is the plan:\n```json\n" +
      '{"summary":"Ship auth","issues":[{"title":"Add login","description":"d","priority":2}],"execute":[0]}' +
      "\n```\nDone.";
    const plan = extractJsonPlan(raw);
    expect(plan).toEqual({
      summary: "Ship auth",
      issues: [{ title: "Add login", description: "d", priority: 2 }],
      execute: [0],
    });
  });

  it("caps issues at 6 and drops titleless/invalid entries", () => {
    const issues = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, description: "", priority: 9 }));
    const raw = JSON.stringify({ summary: "", issues: [...issues, { description: "no title" }], execute: [] });
    const plan = extractJsonPlan(raw);
    expect(plan?.issues).toHaveLength(6);
    expect(plan?.issues.every((i) => i.priority === 4)).toBe(true); // 9 clamped to 4
  });

  it("filters execute indexes out of range and dedups", () => {
    const raw = JSON.stringify({
      summary: "s",
      issues: [{ title: "a" }, { title: "b" }],
      execute: [0, 0, 1, 5, -1],
    });
    expect(extractJsonPlan(raw)?.execute).toEqual([0, 1]);
  });

  it("returns null for no JSON / no usable issues", () => {
    expect(extractJsonPlan("no json here")).toBeNull();
    expect(extractJsonPlan(null)).toBeNull();
    expect(extractJsonPlan(JSON.stringify({ summary: "x", issues: [] }))).toBeNull();
  });
});

describe("planNextSteps", () => {
  it("calls the gateway pattern and returns the parsed plan", async () => {
    const seen: { model?: string; opts?: unknown } = {};
    const env = {
      AI_GATEWAY_ID: "x",
      AI: {
        run: async (model: string, _input: unknown, opts: unknown) => {
          seen.model = model;
          seen.opts = opts;
          return {
            choices: [
              {
                message: {
                  content: '{"summary":"go","issues":[{"title":"do it","description":"x","priority":1}],"execute":[0]}',
                },
              },
            ],
          };
        },
      },
    } as never;

    const plan = await planNextSteps(env, {
      name: "Proj",
      description: "desc",
      summary: "sum",
      status: "active",
      openIssues: [],
      repo: "aloewright/fly-dev",
    });

    expect(seen.model).toBe("@cf/openai/gpt-oss-120b");
    expect(seen.opts).toEqual({ gateway: { id: "x" } });
    expect(plan?.issues[0]?.title).toBe("do it");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/planner.test.ts`
Expected: FAIL — module `planner` not found.

- [ ] **Step 3: Implement `planner.ts`**

Create `worker/src/platform/planner.ts`:

```ts
/* AGPL-3.0-or-later */
import type { Env } from "../env";

export type PlannedIssue = { title: string; description: string; priority: number };
export type NextStepPlan = { summary: string; issues: PlannedIssue[]; execute: number[] };

export type ProjectContext = {
  name: string;
  description: string;
  summary: string;
  status: string;
  openIssues: Array<{ identifier: string; title: string; state: string; priority: number }>;
  repo: string | null;
};

const MAX_ISSUES = 6;

// Route through Cloudflare AI Gateway using the sanctioned worker-side pattern
// (env.AI.run with a concrete @cf model id + gateway option). Dynamic routes
// (dynamic/research_gen) are NOT resolvable from inside a Worker today — see
// ~/.claude/CLAUDE.md "Inside a Worker". Swap back to a dynamic route when fixed.
const PLANNER_MODEL = "@cf/openai/gpt-oss-120b";
const PLANNER_MAX_TOKENS = 2048;

const PLANNER_SYSTEM =
  "You are a senior engineering lead. Given a software project's description and its " +
  "open issues, decide the best next steps. Respond with ONLY a JSON object, no prose, " +
  'of the form {"summary": string, "issues": [{"title": string, "description": string, ' +
  '"priority": 1-4}], "execute": number[]}. priority: 1=urgent,2=high,3=medium,4=low. ' +
  "issues: the concrete next pieces of work (max 6), each a self-contained task an " +
  "autonomous coding agent could implement and open a PR for. execute: indexes into " +
  "issues that should begin immediately. Do not duplicate work already covered by an open issue.";

export async function planNextSteps(env: Env, ctx: ProjectContext): Promise<NextStepPlan | null> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  const raw = await (
    env.AI as unknown as {
      run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
    }
  ).run(
    PLANNER_MODEL,
    {
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: buildPlannerPrompt(ctx) },
      ],
      max_tokens: PLANNER_MAX_TOKENS,
    },
    { gateway: { id: gatewayId } },
  );
  return extractJsonPlan(readContent(raw));
}

function buildPlannerPrompt(ctx: ProjectContext): string {
  const issues = ctx.openIssues.length
    ? ctx.openIssues.map((i) => `- [${i.identifier}] ${i.title} (${i.state})`).join("\n")
    : "(none)";
  return [
    `Project: ${ctx.name}`,
    `Status: ${ctx.status}`,
    `Repository: ${ctx.repo ?? "(unmapped)"}`,
    `Summary: ${ctx.summary || "(none)"}`,
    `Description:\n${ctx.description || "(none)"}`,
    `Open issues:\n${issues}`,
    "",
    "Produce the JSON plan now.",
  ].join("\n");
}

function readContent(raw: unknown): string | null {
  const r = raw as { choices?: Array<{ message?: { content?: string | null } }> };
  return r?.choices?.[0]?.message?.content ?? null;
}

// Parse the model's text into a NextStepPlan. Tolerates ```json fences and
// reasoning preambles by extracting the first balanced {...} block. Returns null
// when there is no usable plan (no JSON, or zero valid issues).
export function extractJsonPlan(raw: string | null | undefined): NextStepPlan | null {
  if (!raw) return null;
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const issues: PlannedIssue[] = [];
  for (const item of Array.isArray(obj.issues) ? obj.issues : []) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title) continue;
    issues.push({
      title,
      description: typeof i.description === "string" ? i.description : "",
      priority: clampPriority(i.priority),
    });
    if (issues.length >= MAX_ISSUES) break;
  }
  if (issues.length === 0) return null;

  const execute = (Array.isArray(obj.execute) ? obj.execute : [])
    .map((n) => (typeof n === "number" ? Math.trunc(n) : Number.NaN))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < issues.length);

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    issues,
    execute: [...new Set(execute)],
  };
}

function clampPriority(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : 3;
  return Math.min(Math.max(n, 1), 4);
}

// First balanced top-level JSON object in arbitrary text (string-aware so braces
// inside strings don't throw off the depth count).
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/planner.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/planner.ts tests/planner.test.ts
git commit -m "feat(planner): LLM next-step planner via AI gateway + robust JSON extraction"
```

---

## Task 5: `linear.ts` — resolve team + create issue

**Files:**
- Modify: `worker/src/platform/linear.ts` (add exports + queries)
- Test: `tests/linear.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/linear.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearIssue, resolveProjectTeam } from "../worker/src/platform/linear";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGraphql(data: unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  return calls;
}

describe("resolveProjectTeam", () => {
  it("returns the first team id for a project", async () => {
    const calls = mockGraphql({ project: { teams: { nodes: [{ id: "team_1" }] } } });
    const teamId = await resolveProjectTeam("tok", "proj_1");
    expect(teamId).toBe("team_1");
    expect(calls[0]?.variables).toEqual({ id: "proj_1" });
  });

  it("returns null when the project has no team", async () => {
    mockGraphql({ project: { teams: { nodes: [] } } });
    expect(await resolveProjectTeam("tok", "proj_1")).toBeNull();
  });
});

describe("createLinearIssue", () => {
  it("creates an issue and returns its identifier + url", async () => {
    const calls = mockGraphql({
      issueCreate: {
        success: true,
        issue: { id: "iss_1", identifier: "ENG-12", url: "https://linear.app/x/ENG-12", title: "Do it" },
      },
    });
    const created = await createLinearIssue("tok", {
      teamId: "team_1",
      projectId: "proj_1",
      title: "Do it",
      description: "body",
      priority: 2,
    });
    expect(created).toEqual({
      id: "iss_1",
      identifier: "ENG-12",
      url: "https://linear.app/x/ENG-12",
      title: "Do it",
    });
    expect(calls[0]?.variables).toMatchObject({
      teamId: "team_1",
      projectId: "proj_1",
      title: "Do it",
      description: "body",
      priority: 2,
    });
  });

  it("returns null when creation does not succeed", async () => {
    mockGraphql({ issueCreate: { success: false, issue: null } });
    const created = await createLinearIssue("tok", {
      teamId: "team_1",
      projectId: "proj_1",
      title: "x",
      description: "",
      priority: 3,
    });
    expect(created).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/linear.test.ts`
Expected: FAIL — `createLinearIssue` / `resolveProjectTeam` not exported.

- [ ] **Step 3: Implement the additions**

In `worker/src/platform/linear.ts`, add these exported functions (place after `writeBackToLinear`, before the private `resolveDoneState`):

```ts
export type CreatedLinearIssue = { id: string; identifier: string; url: string; title: string };

// Resolve the first team owning a project. Linear issues require a teamId; a
// project can span teams, so we take the first (sufficient for issue creation).
export async function resolveProjectTeam(token: string, projectId: string): Promise<string | null> {
  const data = await linearRequest<{ project?: { teams?: { nodes?: Array<{ id: string }> } } }>(
    token,
    PROJECT_TEAM_QUERY,
    { id: projectId },
  );
  return data?.project?.teams?.nodes?.[0]?.id ?? null;
}

// Create a Linear issue under a project + team. Returns null when the mutation
// does not report success.
export async function createLinearIssue(
  token: string,
  input: { teamId: string; projectId: string; title: string; description: string; priority: number },
): Promise<CreatedLinearIssue | null> {
  const data = await linearRequest<{
    issueCreate?: {
      success: boolean;
      issue?: { id: string; identifier: string; url: string; title: string } | null;
    };
  }>(token, ISSUE_CREATE_MUTATION, {
    teamId: input.teamId,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    priority: input.priority,
  });
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) return null;
  return { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title };
}
```

Then add the two query constants alongside the existing mutation constants at the
bottom of the file:

```ts
const PROJECT_TEAM_QUERY =
  `query($id: String!) { project(id: $id) { teams(first: 1) { nodes { id } } } }`;
const ISSUE_CREATE_MUTATION =
  `mutation($teamId: String!, $projectId: String!, $title: String!, $description: String!, $priority: Int!) { issueCreate(input: { teamId: $teamId, projectId: $projectId, title: $title, description: $description, priority: $priority }) { success issue { id identifier url title } } }`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/linear.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/linear.ts tests/linear.test.ts
git commit -m "feat(linear): resolveProjectTeam + createLinearIssue"
```

---

## Task 6: `createAutonomousRun()` in orchestration

Reuses the existing, tested `createTaskRun` + `approveRun` transitions rather than
duplicating the INSERT. When `CONTINUE_AUTONOMY === "true"`, the just-created run is
immediately approved (queued); otherwise it stays approval-gated.

**Files:**
- Modify: `worker/src/platform/orchestration.ts` (append exported function)

- [ ] **Step 1: Implement `createAutonomousRun`**

Append to `worker/src/platform/orchestration.ts` (end of file):

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/platform/orchestration.ts
git commit -m "feat(orchestration): createAutonomousRun (create + auto-approve)"
```

---

## Task 7: `continue.ts` — selection logic + orchestration

**Files:**
- Create: `worker/src/platform/continue.ts`
- Test: `tests/continue.test.ts`

- [ ] **Step 1: Write the failing test (pure selection logic)**

Create `tests/continue.test.ts`:

```ts
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { selectExecuteTargets, type CreatedWithMeta } from "../worker/src/platform/continue";

function made(planIndex: number, priority: number): CreatedWithMeta {
  return {
    planIndex,
    priority,
    description: "",
    issue: { id: `i${planIndex}`, identifier: `E-${planIndex}`, url: "u", title: `t${planIndex}` },
  };
}

describe("selectExecuteTargets", () => {
  it("prefers the planner's execute indexes, capped", () => {
    const created = [made(0, 3), made(1, 1), made(2, 2)];
    const picked = selectExecuteTargets([2, 0], created, 3);
    expect(picked.map((p) => p.planIndex)).toEqual([0, 2]); // filtered in created-order
  });

  it("caps the number of targets", () => {
    const created = [made(0, 1), made(1, 1), made(2, 1), made(3, 1)];
    expect(selectExecuteTargets([0, 1, 2, 3], created, 2)).toHaveLength(2);
  });

  it("falls back to top priority when execute is empty", () => {
    const created = [made(0, 4), made(1, 1), made(2, 2)];
    const picked = selectExecuteTargets([], created, 2);
    expect(picked.map((p) => p.planIndex)).toEqual([1, 2]); // priority 1 then 2
  });

  it("ignores execute indexes with no created issue (creation failed)", () => {
    const created = [made(0, 2), made(2, 2)]; // index 1 failed to create
    const picked = selectExecuteTargets([1], created, 3);
    // no created issue matches index 1 -> fall back to top priority
    expect(picked.map((p) => p.planIndex)).toEqual([0, 2]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/continue.test.ts`
Expected: FAIL — module `continue` not found.

- [ ] **Step 3: Implement `continue.ts`**

Create `worker/src/platform/continue.ts`:

```ts
/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { first } from "./data";
import { autoMapProjects, getDecryptedToken, getLinearProjectIssues } from "./integrations";
import { planNextSteps, type ProjectContext } from "./planner";
import { createLinearIssue, resolveProjectTeam, type CreatedLinearIssue } from "./linear";
import { createAutonomousRun } from "./orchestration";

const DEFAULT_EXECUTE_CAP = 3;

export type CreatedWithMeta = {
  planIndex: number;
  priority: number;
  description: string;
  issue: CreatedLinearIssue;
};

export type ContinueResult = {
  summary: string;
  createdIssues: CreatedLinearIssue[];
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};

// Choose which created issues to execute: prefer the planner's `execute` indexes
// (those that actually got created), else fall back to highest priority. Capped.
export function selectExecuteTargets(
  executeIndexes: number[],
  created: CreatedWithMeta[],
  cap: number,
): CreatedWithMeta[] {
  const wanted = new Set(executeIndexes);
  let pool = created.filter((c) => wanted.has(c.planIndex));
  if (pool.length === 0) {
    pool = [...created].sort((a, b) => a.priority - b.priority); // 1=urgent first
  }
  return pool.slice(0, Math.max(0, cap));
}

export async function continueProject(env: Env, user: CurrentUser, projectId: string): Promise<Response> {
  // 1. Review: project + repo mapping + open issues.
  const project = await first<{
    id: string;
    name: string;
    description: string | null;
    summary: string | null;
    status: string;
  }>(env, "SELECT id, name, description, summary, status FROM linear_projects WHERE id = ?", [projectId]);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  let repo = await activeRepo(env, projectId);
  if (!repo) {
    await autoMapProjects(env, user.id).catch(() => undefined);
    repo = await activeRepo(env, projectId);
  }
  if (!repo) {
    return Response.json(
      { error: "No GitHub repo mapped to this project. Map a repo first.", needsRepo: true },
      { status: 409 },
    );
  }

  const linearToken = await getDecryptedToken(env, user.id, "linear");
  if (!linearToken) {
    return Response.json({ error: "Linear is not connected" }, { status: 400 });
  }

  const { issues: openIssues } = await getLinearProjectIssues(env, user.id, projectId);

  // 2. Plan.
  const ctx: ProjectContext = {
    name: project.name,
    description: project.description ?? "",
    summary: project.summary ?? "",
    status: project.status,
    openIssues: openIssues.map((i) => ({
      identifier: i.identifier,
      title: i.title,
      state: i.state,
      priority: i.priority,
    })),
    repo: `${repo.owner}/${repo.repo}`,
  };
  const plan = await planNextSteps(env, ctx);
  if (!plan) {
    return Response.json({ error: "Planner returned no usable plan" }, { status: 502 });
  }

  // 3. Break down into Linear issues, remembering each one's plan index.
  const teamId = await resolveProjectTeam(linearToken, projectId);
  if (!teamId) {
    return Response.json({ error: "Could not resolve a Linear team for this project" }, { status: 502 });
  }
  const created: CreatedWithMeta[] = [];
  for (let planIndex = 0; planIndex < plan.issues.length; planIndex += 1) {
    const planned = plan.issues[planIndex];
    const issue = await createLinearIssue(linearToken, {
      teamId,
      projectId,
      title: planned.title,
      description: planned.description,
      priority: planned.priority,
    });
    if (issue) {
      created.push({ planIndex, priority: planned.priority, description: planned.description, issue });
    }
  }

  // 4. Execute the selected subset (autonomous when CONTINUE_AUTONOMY is on).
  const targets = selectExecuteTargets(plan.execute, created, executeCap(env));
  const queuedRuns: Array<{ id: string; issue: string }> = [];
  for (const target of targets) {
    const run = await createAutonomousRun(env, user, {
      objective: `${target.issue.title}\n\n${target.description}`.trim(),
      linearProjectId: projectId,
      linearIssueId: target.issue.id,
      linearTeamId: teamId,
      agentProvider: "claude-code",
      source: "continue",
    }).catch(() => null);
    if (run) queuedRuns.push({ id: run.id, issue: target.issue.identifier });
  }

  return Response.json({
    summary: plan.summary,
    createdIssues: created.map((c) => c.issue),
    queuedRuns,
    skipped: Math.max(0, created.length - queuedRuns.length),
  } satisfies ContinueResult);
}

async function activeRepo(env: Env, projectId: string): Promise<{ owner: string; repo: string } | null> {
  return first<{ owner: string; repo: string }>(
    env,
    "SELECT owner, repo FROM repository_mappings WHERE linear_project_id = ? AND status = 'active' ORDER BY confidence DESC LIMIT 1",
    [projectId],
  );
}

function executeCap(env: Env): number {
  const n = Number.parseInt(env.CONTINUE_EXECUTE_CAP ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EXECUTE_CAP;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/continue.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/continue.ts tests/continue.test.ts
git commit -m "feat(continue): project review -> plan -> issues -> autonomous runs"
```

---

## Task 8: Wire routes + harden `/api/overview`

**Files:**
- Modify: `worker/src/index.ts` (imports near lines 17-52; `/api/overview` at 97-99; new routes near the other `/api/projects/:id/*` and `/api/internal/*` handlers)

- [ ] **Step 1: Add imports**

In `worker/src/index.ts`, add `reclaimUserData` to the existing `./platform/data`
import block (the one that currently imports `all, ensureUser, first, …`):

```ts
  recordUsage,
  reclaimUserData,
} from "./platform/data";
```

And add a new import line after the `./platform/linear` import:

```ts
import { continueProject } from "./platform/continue";
```

- [ ] **Step 2: Harden `/api/overview`**

Replace the existing handler:

```ts
app.get("/api/overview", async (c) => {
  return c.json(await getOverview(c.env, c.get("user")));
});
```

with:

```ts
app.get("/api/overview", async (c) => {
  const user = c.get("user");
  const overview = await getOverview(c.env, user);
  // Self-heal: if an authed user has zero repos but a sync is possible (PAT set or
  // GitHub connected), kick off a one-shot backfill in the background. Guarded by a
  // per-user KV flag so it runs at most once an hour and never blocks the response.
  // Without this, an identity change (see the repos-fix spec) leaves repos empty
  // with no obvious recovery. Repos appear on the next refresh.
  if (user && overview.repos.length === 0) {
    const githubConnected = overview.connections.some(
      (conn) => conn.provider === "github" && conn.status === "connected",
    );
    if (c.env.GITHUB_PAT || githubConnected) {
      const flagKey = `repos-autosync:${user.id}`;
      const alreadyTried = await c.env.CACHE.get(flagKey);
      if (!alreadyTried) {
        await c.env.CACHE.put(flagKey, "1", { expirationTtl: 3600 });
        c.executionCtx.waitUntil(backfillGithubRepos(c.env, user.id).catch(() => undefined));
      }
    }
  }
  return c.json(overview);
});
```

(`backfillGithubRepos` is already imported from `./platform/integrations`.)

- [ ] **Step 3: Add the Continue route**

Immediately after the existing `app.get("/api/projects/:id/issues", …)` handler, add:

```ts
// Autonomous "Continue": review the project, plan next steps, create Linear issues,
// and (when CONTINUE_AUTONOMY is on) start runs. See platform/continue.ts.
app.post("/api/projects/:id/continue", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return continueProject(c.env, user, c.req.param("id"));
});
```

- [ ] **Step 4: Add the reclaim route**

After the existing `app.post("/api/internal/summon", …)` handler, add:

```ts
// One-time, idempotent reconciliation of orphaned user-scoped data into a single
// canonical user (see the 2026-06-02 repos-fix spec). HMAC-gated like other
// internal routes.
app.post("/api/internal/reclaim", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as { intoUserId?: string } | null;
  if (!body?.intoUserId) {
    return c.json({ error: "intoUserId is required" }, 400);
  }
  const counts = await reclaimUserData(c.env, body.intoUserId);
  const mapped = await autoMapProjects(c.env, body.intoUserId).catch(() => null);
  return c.json({ ok: true, ...counts, mapped });
});
```

(`autoMapProjects` is already imported from `./platform/integrations`;
`verifyInternalRequest` from `./platform/auth-session`.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(api): continue + reclaim routes; auto-backfill repos on empty overview"
```

---

## Task 9: UI — Continue button + repos Sync affordance

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the `ContinueResult` type**

In `src/App.tsx`, after the `LinearIssue` type (around line 124), add:

```ts
type ContinueResult = {
  summary: string;
  createdIssues: Array<{ id: string; identifier: string; url: string; title: string }>;
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};
```

- [ ] **Step 2: Widen the sync mutation result type**

In `App()`, change the `sync` mutation's type argument from
`fetchJson<{ synced: number }>` to:

```ts
    mutationFn: (provider: Provider) =>
      fetchJson<{ synced: number; reason?: string }>(`/api/integrations/${provider}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
```

- [ ] **Step 3: Add a Sync affordance + result text to the GitHub Repos card header**

Replace the GitHub Repos card header `Box` (the one containing
`<Title …>GitHub Repos</Title>` and the count `Text`) with:

```tsx
              <Box px="lg" py="sm" style={sectionHeader}>
                <Group justify="space-between">
                  <Title order={2} size="h4">
                    GitHub Repos
                  </Title>
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {(overview?.repos ?? []).length}
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      loading={sync.isPending && sync.variables === "github"}
                      onClick={() => sync.mutate("github")}
                    >
                      Sync repos
                    </Button>
                  </Group>
                </Group>
                {sync.data && sync.variables === "github" ? (
                  <Text size="xs" c={sync.data.reason ? "red" : "dimmed"} mt={4}>
                    {sync.data.reason ?? `Synced ${sync.data.synced} repos`}
                  </Text>
                ) : null}
                {sync.error && sync.variables === "github" ? (
                  <Text size="xs" c="red" mt={4}>
                    {(sync.error as Error).message}
                  </Text>
                ) : null}
              </Box>
```

- [ ] **Step 4: Make the empty-repos row actionable**

Replace:

```tsx
                {(overview?.repos ?? []).length === 0 ? (
                  <EmptyRow label="No repos synced — connect GitHub or hit Sync" />
                ) : null}
```

with:

```tsx
                {(overview?.repos ?? []).length === 0 ? (
                  <Box px="lg" py="xl">
                    <Text c="dimmed" size="sm" mb="sm">
                      No repos synced yet.
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      loading={sync.isPending && sync.variables === "github"}
                      onClick={() => sync.mutate("github")}
                    >
                      Sync repos now
                    </Button>
                  </Box>
                ) : null}
```

- [ ] **Step 5: Add the Continue control to `ProjectRow`**

In `ProjectRow`, add state + mutation at the top of the component (after the
existing `setMapping` mutation):

```ts
  const [confirming, setConfirming] = useState(false);
  const continueMutation = useMutation({
    mutationFn: () =>
      fetchJson<ContinueResult>(`/api/projects/${project.id}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["issues", project.id] });
    },
  });
```

Then, inside the `expanded` block, immediately after the closing `</Group>` of the
repo-select `Group` (the one containing the `Select label="GitHub repo"`), insert:

```tsx
          <Group gap="xs" align="center" pb="xs" wrap="wrap">
            {confirming ? (
              <>
                <Text size="xs" c="dimmed">
                  Creates Linear issues and starts runs.
                </Text>
                <Button
                  size="xs"
                  color="teal"
                  loading={continueMutation.isPending}
                  onClick={() => continueMutation.mutate()}
                >
                  Confirm
                </Button>
                <Button size="xs" variant="subtle" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="xs" onClick={() => setConfirming(true)}>
                Continue ▶
              </Button>
            )}
          </Group>

          {continueMutation.error ? (
            <Text size="xs" c="red" pb="xs">
              {(continueMutation.error as Error).message}
            </Text>
          ) : null}

          {continueMutation.data ? (
            <Stack gap={4} pb="xs">
              {continueMutation.data.summary ? (
                <Text size="xs" c="dimmed">
                  {continueMutation.data.summary}
                </Text>
              ) : null}
              {continueMutation.data.createdIssues.map((iss) => (
                <Anchor key={iss.id} href={iss.url} target="_blank" size="xs" truncate>
                  <Text component="span" size="xs" c="dimmed" mr={6}>
                    {iss.identifier}
                  </Text>
                  {iss.title}
                </Anchor>
              ))}
              <Text size="xs" c="dimmed">
                {continueMutation.data.queuedRuns.length} run(s) started ·{" "}
                {continueMutation.data.skipped} issue(s) queued
              </Text>
            </Stack>
          ) : null}
```

- [ ] **Step 6: Typecheck + build the client**

Run: `npm run typecheck && npm run build`
Expected: PASS — tsc clean, vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): Continue button + repos sync affordance and error surfacing"
```

---

## Task 10: Full gate, then run the one-time prod reclaim

**Files:** none (verification + ops)

- [ ] **Step 1: Run the whole test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files PASS (repo-mapping, crypto, reclaim, planner, linear, continue); typecheck clean.

- [ ] **Step 2: Confirm current orphaned state (read-only)**

Run:
```bash
npx wrangler d1 execute fly-dev --remote --json --command "SELECT user_id, COUNT(*) AS n FROM github_repos GROUP BY user_id;"
```
Expected: 274 repos under `user_cbc0630b1076463292882285296a396f`, 0 under `user_526c841c1a404bff9278740309b1333f`.

- [ ] **Step 3: Run the reclaim against prod**

This re-points the orphaned rows into the canonical `fly` user and removes legacy
connection duplicates. Hard-to-reverse data change — confirm the canonical id below
matches the current `fly` user before running.

```bash
CANON=user_526c841c1a404bff9278740309b1333f
npx wrangler d1 execute fly-dev --remote --command "\
UPDATE github_repos   SET user_id='$CANON' WHERE user_id!='$CANON'; \
UPDATE runs           SET user_id='$CANON' WHERE user_id!='$CANON'; \
UPDATE usage_events   SET user_id='$CANON' WHERE user_id!='$CANON'; \
UPDATE agent_memories SET user_id='$CANON' WHERE user_id!='$CANON'; \
DELETE FROM account_connections WHERE user_id!='$CANON';"
```
Expected: UPDATE/DELETE statements report rows changed (≈274 repos).

- [ ] **Step 4: Verify the canonical user now owns the repos**

Run:
```bash
npx wrangler d1 execute fly-dev --remote --json --command "SELECT COUNT(*) AS n FROM github_repos WHERE user_id='user_526c841c1a404bff9278740309b1333f';"
```
Expected: `n` ≈ 275.

- [ ] **Step 5: Map projects against the reclaimed repos**

The dashboard's existing "Auto-map repos" button (or the next Continue click) runs
`autoMapProjects` for the current user. No command needed — note in the PR that the
operator should click "Auto-map repos" after deploy so projects gain repo mappings.

---

## Self-review notes

- **Spec coverage:** A1 reclaim → Tasks 3, 8 (endpoint), 10 (run). A2 harden:
  auto-backfill → Task 8; surfaced errors → Tasks 1, 9; PAT-aware Sync → Task 9.
  B1 UI → Task 9. B2 endpoint steps 1-5 → Tasks 4 (plan), 5 (issues), 6/7
  (execute), 8 (route). B3 files → all covered. B4 error handling → continue.ts
  returns 404/409/400/502; UI shows messages via Task 1. Env flags → Task 2.
  Tests → Tasks 3,4,5,7 (+ existing suite in Task 10).
- **Identifier consistency:** `ProjectContext`, `NextStepPlan`, `PlannedIssue`,
  `CreatedLinearIssue`, `CreatedWithMeta`, `ContinueResult`, `selectExecuteTargets`,
  `createAutonomousRun`, `createLinearIssue`, `resolveProjectTeam`,
  `reclaimUserData`, `continueProject` are used identically across tasks.
- **Known limitation (documented):** `reclaimUserData` collapses ALL non-canonical
  users into one — correct for this single-operator tool, not for multi-tenancy.
  The deeper "stable identity by email" fix was explicitly deferred (spec chose
  "Reclaim + harden").
