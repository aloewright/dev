# Command Center Live-View + Execution Un-Deadlock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream per-run progress from the sandbox container to the worker so the UI can render a live Command Center, and make the capacity gate immune to not-yet-ready / stalled runs so the queue cannot deadlock.

**Architecture:** Container `step()` logs become HMAC-signed POSTs to a new worker ingest endpoint that writes `run_events` and bumps `runs.last_heartbeat_at`. A new transient `starting` status keeps a slot un-consumed until ports are ready; a heartbeat-based reaper requeues runs with no heartbeat for 8 min. The frontend gets an AppShell with a Command Center page whose `RunCard`s stream events over SSE.

**Tech Stack:** Cloudflare Workers (Hono), D1, Durable Object Containers, Node 22 (container), React 19 + Mantine 9 + @tanstack/react-router, vitest.

Spec: `docs/superpowers/specs/2026-06-05-command-center-live-view-and-execution-unblock-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0023_run_heartbeat.sql` | add `last_heartbeat_at` + index |
| `worker/src/platform/data.ts` | `getActiveRunCount` counts `starting`+`running`; `bumpHeartbeat` |
| `worker/src/platform/orchestration.ts` | `markRunStarting`, `markRunReady` (replaces inline `markRunStarted` use) |
| `worker/src/platform/run-liveness.ts` (new) | pure `isStalledRun()` predicate + constants |
| `worker/src/platform/run-summary.ts` (new) | `summarizeRunForMemory()` forward-compat seam |
| `worker/src/index.ts` | ingest endpoint, SSE endpoint, RunWorkflow `starting`→ready + fail-fast, reaper rule, callback fields in `/run` body, `dev.fly.pm` in `allowedHosts` |
| `container/server.mjs` | `emit()` + heartbeat timer; `step()` also emits |
| `container/event-throttle.mjs` (new) | pure throttle helper (unit-tested) |
| `src/router.tsx` | add `/command-center` route + shared root layout |
| `src/AppShell.tsx` (new) | sidebar shell (Dashboard / Command Center) |
| `src/CommandCenter.tsx` (new) | grid of `RunCard`s |
| `src/RunCard.tsx` (new) | live terminal log via EventSource + actions |
| `src/lib/event-style.ts` (new) | pure event-type→color mapping (unit-tested) |
| `tests/run-liveness.test.ts` (new) | reaper predicate tests |
| `tests/run-summary.test.ts` (new) | memory-seam tests |
| `tests/event-style.test.ts` (new) | color mapping tests |
| `container/event-throttle.test.mjs` (new) | throttle tests |

---

## Task 1: Migration — `last_heartbeat_at`

**Files:**
- Create: `migrations/0023_run_heartbeat.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0023_run_heartbeat.sql
-- Liveness column: bumped on every container heartbeat/event so the reaper can
-- distinguish a live run from a hung one in minutes instead of ~2 hours.
ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_status_heartbeat ON runs (status, last_heartbeat_at);
```

- [ ] **Step 2: Apply locally to verify it parses**

Run: `wrangler d1 migrations apply fly-dev --local`
Expected: applies `0023_run_heartbeat.sql` with no error.

- [ ] **Step 3: Commit**

```bash
git add migrations/0023_run_heartbeat.sql
git commit -m "feat(db): add runs.last_heartbeat_at for liveness tracking"
```

---

## Task 2: Liveness predicate (pure, TDD)

A pure function the reaper uses so we can unit-test it without D1.

**Files:**
- Create: `worker/src/platform/run-liveness.ts`
- Test: `tests/run-liveness.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { isStalledRun, STALL_THRESHOLD_MS } from "../worker/src/platform/run-liveness";

const now = Date.parse("2026-06-05T12:00:00Z");

describe("isStalledRun", () => {
  it("flags a running run whose last heartbeat is older than the threshold", () => {
    const hb = new Date(now - STALL_THRESHOLD_MS - 1000).toISOString();
    expect(isStalledRun({ status: "running", lastHeartbeatAt: hb }, now)).toBe(true);
  });

  it("does not flag a running run heartbeating within the window", () => {
    const hb = new Date(now - 5000).toISOString();
    expect(isStalledRun({ status: "running", lastHeartbeatAt: hb }, now)).toBe(false);
  });

  it("treats a missing heartbeat on a starting run as stalled", () => {
    expect(isStalledRun({ status: "starting", lastHeartbeatAt: null }, now)).toBe(true);
  });

  it("ignores terminal statuses", () => {
    const hb = new Date(now - STALL_THRESHOLD_MS - 1000).toISOString();
    expect(isStalledRun({ status: "completed", lastHeartbeatAt: hb }, now)).toBe(false);
    expect(isStalledRun({ status: "queued", lastHeartbeatAt: null }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-liveness.test.ts`
Expected: FAIL — cannot find module `run-liveness`.

- [ ] **Step 3: Write the implementation**

```typescript
/* AGPL-3.0-or-later */

// A run is "active" (occupies a container slot) while starting or running.
export const ACTIVE_STATUSES = ["starting", "running"] as const;

// No heartbeat within this window ⇒ the container is presumed dead. Container
// emits a heartbeat every ~15s, so 8 minutes tolerates ~30 missed beats.
export const STALL_THRESHOLD_MS = 8 * 60 * 1000;

export interface RunLiveness {
  status: string;
  lastHeartbeatAt: string | null;
}

export function isStalledRun(run: RunLiveness, nowMs: number): boolean {
  if (!ACTIVE_STATUSES.includes(run.status as (typeof ACTIVE_STATUSES)[number])) {
    return false;
  }
  // A never-heartbeated active run is stalled (container never came up / never called back).
  if (!run.lastHeartbeatAt) return true;
  const hb = Date.parse(run.lastHeartbeatAt);
  if (Number.isNaN(hb)) return true;
  return nowMs - hb > STALL_THRESHOLD_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run-liveness.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/run-liveness.ts tests/run-liveness.test.ts
git commit -m "feat(reaper): pure isStalledRun liveness predicate"
```

---

## Task 3: Capacity counter + heartbeat bump (`data.ts`)

**Files:**
- Modify: `worker/src/platform/data.ts:515-518` (`getActiveRunCount`) and append `bumpHeartbeat`

- [ ] **Step 1: Update `getActiveRunCount` to count starting+running**

Replace the body of `getActiveRunCount`:

```typescript
export async function getActiveRunCount(env: Env): Promise<number> {
  // Count both transient `starting` and `running` so the 8-slot gate is never
  // over-subscribed while a container is booting.
  const res = await first<{ count: number }>(
    env,
    "SELECT count(*) as count FROM runs WHERE status IN ('starting','running')",
  );
  return res?.count ?? 0;
}
```

- [ ] **Step 2: Append `bumpHeartbeat` to `data.ts`**

```typescript
// Bump liveness on every container event/heartbeat. Only affects active runs so a
// late callback after completion cannot resurrect timestamps on a terminal row.
export async function bumpHeartbeat(env: Env, runId: string): Promise<void> {
  await runSql(
    env,
    `UPDATE runs SET last_heartbeat_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('starting','running')`,
    [runId],
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/platform/data.ts
git commit -m "feat(capacity): count starting+running; add bumpHeartbeat"
```

---

## Task 4: `starting` status transitions (`orchestration.ts`)

Split the old `markRunStarted` (which set `running` + emitted `container.start`) into
two: `markRunStarting` (slot reserved, ports not yet up) and `markRunReady` (ports up).

**Files:**
- Modify: `worker/src/platform/orchestration.ts:300-311`

- [ ] **Step 1: Replace `markRunStarted` with two functions**

```typescript
// Reserve the slot: container requested but not yet confirmed up. Sets the first
// heartbeat so the stall window starts counting from the request, not from never.
export async function markRunStarting(env: Env, runId: string, sandboxId: string): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
       SET status = 'starting', sandbox_id = ?,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
           last_heartbeat_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [sandboxId, runId],
  );
  await recordRunEvent(env, runId, "container.start", "Sandbox container start requested.", "info", {
    sandboxId,
  });
}

// Ports are ready and the run is dispatched: promote to running.
export async function markRunReady(env: Env, runId: string): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
       SET status = 'running', last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'starting'`,
    [runId],
  );
  await recordRunEvent(env, runId, "container.ready", "Sandbox container ready; dispatching.", "info");
}
```

- [ ] **Step 2: Find remaining `markRunStarted` references**

Run: `grep -rn "markRunStarted" worker/src`
Expected: only the import + call site in `index.ts` (RunWorkflow). Task 5 updates them. If other call sites exist, point each at `markRunStarting`.

- [ ] **Step 3: Typecheck (expected to fail until Task 5)**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: error that `markRunStarted` is no longer exported — resolved in Task 5. Proceed.

- [ ] **Step 4: Commit**

```bash
git add worker/src/platform/orchestration.ts
git commit -m "feat(orchestration): split run start into starting/ready transitions"
```

---

## Task 5: RunWorkflow — starting→ready + fail-fast + callback fields

**Files:**
- Modify: `worker/src/index.ts` — import line 994-region, the `reserve sandbox` / `start sandbox container` / `dispatch to agent` steps (~1001-1068); `allowedHosts` (~973).

- [ ] **Step 1: Update the import**

In `worker/src/index.ts`, change the orchestration import to use the new names:

```typescript
// was: markRunStarted
import { markRunStarting, markRunReady } from "./platform/orchestration";
```
(Keep the other existing imports from that module intact — only swap `markRunStarted` → `markRunStarting, markRunReady`.)

- [ ] **Step 2: `reserve sandbox` step uses `markRunStarting`**

Replace the `reserve sandbox` step body:

```typescript
    const sandboxId = await step.do("reserve sandbox", async () => {
      const sandboxIdValue = `run-${payload.runId}`;
      await markRunStarting(this.env, payload.runId, sandboxIdValue);
      return sandboxIdValue;
    });
```

- [ ] **Step 3: Fail-fast around container start, then mark ready**

Replace the `start sandbox container` step with a try/catch that fails the run fast on a boot error (freeing the slot) and promotes to `running` on success:

```typescript
    await step.do("start sandbox container", async () => {
      const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
      const container = getContainer(containerNamespace, sandboxId);
      try {
        await container.startAndWaitForPorts([8080], {
          instanceGetTimeoutMS: 30_000,
          portReadyTimeoutMS: 60_000,
          waitInterval: 1_000,
        });
      } catch (error) {
        // Fail fast: never leave the row stranded in `starting`/`running` holding a slot.
        // markRunFailed records a retryable error; the reaper/queue picks it up.
        await markRunFailed(this.env, payload.runId, new Error(`container_start_failed: ${String(error)}`));
        throw error;
      }
      await markRunReady(this.env, payload.runId);
    });
```

- [ ] **Step 4: Add callback fields to the `/run` body**

In the `dispatch to agent` step, add two fields to the JSON body so the container can call back. Insert after `claudeOauthToken: creds.claudeOauthToken,`:

```typescript
            claudeOauthToken: creds.claudeOauthToken,
            // Live event callback: container POSTs progress to the worker (HMAC-signed).
            callbackBaseUrl: this.env.APP_URL,
            callbackSecret: this.env.INTERNAL_API_SECRET ?? "",
```

- [ ] **Step 5: Allow the worker host so the container can reach the callback**

`enableInternet=false` + `interceptHttps` means only `allowedHosts` are reachable. Add `dev.fly.pm` to the `allowedHosts` array (~line 973):

```typescript
    "sum.golang.org",
    // Worker origin for the live-event callback (POST /api/internal/runs/:id/events).
    "dev.fly.pm",
  ];
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: no errors (resolves Task 4's dangling reference).

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(workflow): starting->ready, fail-fast on container boot, callback fields"
```

---

## Task 6: Internal event-ingest endpoint

**Files:**
- Modify: `worker/src/index.ts` — add route near the other `/api/internal/*` routes (~756). Uses existing `verifyInternalRequest`, `recordRunEvent`, new `bumpHeartbeat`.

- [ ] **Step 1: Add the ingest route**

```typescript
// Container → worker live event stream. HMAC-gated (same scheme as /api/internal/status).
// Body: { eventType, message, severity?, metadata? }. Writes run_events + bumps heartbeat.
app.post("/api/internal/runs/:id/events", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const runId = c.req.param("id");
  let body: { eventType?: string; message?: string; severity?: string; metadata?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.eventType || typeof body.eventType !== "string") {
    return c.json({ error: "missing_event_type" }, 400);
  }
  await recordRunEvent(
    c.env,
    runId,
    body.eventType,
    typeof body.message === "string" ? body.message.slice(0, 2000) : "",
    body.severity === "error" || body.severity === "warn" ? body.severity : "info",
    body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  );
  await bumpHeartbeat(c.env, runId);
  return c.json({ ok: true });
});
```

- [ ] **Step 2: Add `bumpHeartbeat` to the data.ts import in index.ts**

Find the existing import from `./platform/data` and add `bumpHeartbeat` to the named imports.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(api): HMAC-gated container event ingest endpoint"
```

---

## Task 7: Heartbeat-based reaper rule

**Files:**
- Modify: `worker/src/index.ts` — `reapStuckRuns` SELECT (~1221-1227); import `isStalledRun`/`STALL_THRESHOLD_MS` not needed for SQL but the SQL encodes the same 8-min window.

- [ ] **Step 1: Replace the stuck-running clause with a heartbeat window**

Change the `OR (status = 'running' AND started_at <= datetime('now','-110 minutes'))` line and add `starting`, keying off `last_heartbeat_at`. Also add `last_heartbeat_at` to the SELECT list so the column is available if needed:

```typescript
    `SELECT id, user_id, project_id, status, last_error, metadata_json, last_heartbeat_at
       FROM runs
      WHERE (status = 'failed'  AND finished_at >= datetime('now','-6 hours'))
         OR (status IN ('running','starting') AND COALESCE(last_heartbeat_at, started_at) <= datetime('now','-8 minutes'))
         OR (status = 'queued'  AND updated_at  <= datetime('now','-15 minutes'))
      ORDER BY updated_at ASC
      LIMIT 50`,
```

Update the destructured row type to include `last_heartbeat_at: string | null;`.

- [ ] **Step 2: Confirm `reapKind` maps `starting` like `running`**

Run: `sed -n '46,56p' worker/src/platform/reaper-policy.ts`
If `reapKind` only special-cases `"failed"` → `"error"` and everything else → `"stuck"`, no change is needed (`starting` falls into `stuck`). If it explicitly checks `"running"`, add `"starting"` alongside it.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(reaper): requeue runs with no heartbeat for 8min (was 110min)"
```

---

## Task 8: Container throttle helper (pure, TDD)

**Files:**
- Create: `container/event-throttle.mjs`
- Test: `container/event-throttle.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from "vitest";
import { createThrottle } from "./event-throttle.mjs";

describe("createThrottle", () => {
  it("allows the first call and blocks within the interval", () => {
    let now = 1000;
    const t = createThrottle(1000, () => now);
    expect(t("agent.output")).toBe(true);   // first
    now = 1500;
    expect(t("agent.output")).toBe(false);  // within 1000ms
    now = 2001;
    expect(t("agent.output")).toBe(true);   // window elapsed
  });

  it("throttles per key independently", () => {
    let now = 0;
    const t = createThrottle(1000, () => now);
    expect(t("a")).toBe(true);
    expect(t("b")).toBe(true);   // different key, not throttled
  });

  it("never throttles keys in the always-pass set", () => {
    let now = 0;
    const t = createThrottle(1000, () => now, new Set(["clone.start"]));
    expect(t("clone.start")).toBe(true);
    expect(t("clone.start")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/event-throttle.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// Rate-limits high-frequency event types (e.g. agent.output) so the worker/D1
// isn't flooded. Lifecycle events pass through via alwaysPass.
export function createThrottle(intervalMs, nowFn = () => Date.now(), alwaysPass = new Set()) {
  const last = new Map();
  return (key) => {
    if (alwaysPass.has(key)) return true;
    const now = nowFn();
    const prev = last.get(key) ?? -Infinity;
    if (now - prev >= intervalMs) {
      last.set(key, now);
      return true;
    }
    return false;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/event-throttle.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add container/event-throttle.mjs container/event-throttle.test.mjs
git commit -m "feat(container): pure event throttle helper"
```

---

## Task 9: Container `emit()` + heartbeat + wire into `step()`

**Files:**
- Modify: `container/server.mjs` — `step()` (~44-46), add `emit`/heartbeat near the top, init per-run callback in `handleRun` (~471) and clear heartbeat on completion.

- [ ] **Step 1: Add imports + emit + heartbeat at the top of `server.mjs`**

Add near the existing imports:

```javascript
import { createHmac } from "node:crypto";
import { createThrottle } from "./event-throttle.mjs";

// Per-run live callback config, set at the start of handleRun.
let callback = null; // { baseUrl, secret, runId }
let heartbeatTimer = null;
const outputThrottle = createThrottle(1000, () => Date.now(), new Set([
  "clone.start", "clone.done", "agent.start", "agent.done", "tests", "push", "pr.opened", "agent.result",
]));

// Sign + POST a single event to the worker. Best-effort: failures never break the run.
async function emit(eventType, message, severity = "info", metadata = {}) {
  if (!callback?.baseUrl || !callback?.secret) return;
  if (!outputThrottle(eventType)) return;
  try {
    const body = JSON.stringify({ eventType, message: String(message ?? "").slice(0, 2000), severity, metadata });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", callback.secret).update(`${timestamp}.${body}`).digest("hex");
    await fetch(`${callback.baseUrl}/api/internal/runs/${callback.runId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fly-timestamp": timestamp,
        "x-fly-signature": signature,
      },
      body,
    });
  } catch {
    // swallow — the final result blob is still authoritative
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => { void emit("heartbeat", "", "info"); }, 15_000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
```

Note: the worker `isFreshTimestamp` check — verify it accepts millisecond epoch strings. If `isFreshTimestamp` expects seconds, use `String(Math.floor(Date.now() / 1000))` here. Check: `grep -n "isFreshTimestamp" worker/src/platform/auth-session.ts` and read its body before finalizing.

- [ ] **Step 2: Make `step()` also emit**

Replace `step()`:

```javascript
function step(runId, stage, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), runId, stage, ...extra }));
  // Mirror the lifecycle log to the worker as a live event (best-effort).
  void emit(stage, extra.message ?? "", extra.severity ?? "info", extra);
}
```

- [ ] **Step 3: Initialize the callback + heartbeat in `handleRun`**

Right after `job = JSON.parse(rawBody);` validation passes (after the `missing_required_fields` guard, ~line 480), add:

```javascript
  callback = job.callbackBaseUrl && job.callbackSecret
    ? { baseUrl: job.callbackBaseUrl.replace(/\/$/, ""), secret: job.callbackSecret, runId: job.runId }
    : null;
  startHeartbeat();
```

- [ ] **Step 4: Stop the heartbeat when the run ends**

`handleRun` has multiple `return` points. Wrap its body so the heartbeat always stops. The simplest robust approach: rename the existing function to `handleRunInner` and add a wrapper:

```javascript
async function handleRun(rawBody) {
  try {
    return await handleRunInner(rawBody);
  } finally {
    stopHeartbeat();
    callback = null;
  }
}
```

Rename the existing `async function handleRun(rawBody) {` (the big one) to `async function handleRunInner(rawBody) {`. Move the Step-3 callback init to the top of `handleRunInner`.

- [ ] **Step 5: Run container helper tests (sanity, no full container run)**

Run: `npx vitest run container/event-throttle.test.mjs`
Expected: still PASS (no regressions; `emit` itself is exercised in deploy verification).

- [ ] **Step 6: Commit**

```bash
git add container/server.mjs
git commit -m "feat(container): stream step events + 15s heartbeat to the worker"
```

---

## Task 10: SSE stream endpoint

**Files:**
- Modify: `worker/src/index.ts` — add after the existing `/api/runs/:id/events` route (~556).

- [ ] **Step 1: Add the SSE route**

```typescript
// Server-sent events: live run event stream for the Command Center. Polls D1 by
// id-cursor and pushes new rows; closes on terminal status or after a max lifetime.
app.get("/api/runs/:id/events/stream", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const runId = c.req.param("id");
  const owned = await first<{ id: string }>(
    c.env,
    "SELECT id FROM runs WHERE id = ? AND user_id = ?",
    [runId, user.id],
  );
  if (!owned) return c.json({ error: "Run not found" }, 404);

  const env = c.env;
  const encoder = new TextEncoder();
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  const MAX_LIFETIME_MS = 15 * 60 * 1000;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let cursor = 0;
      let lastStatus = "";
      const startedAt = Date.now();
      send("open", { runId });

      // Poll loop. Workers allow long-lived streams within request limits; the
      // 15-min cap + terminal-status close keep it bounded.
      while (Date.now() - startedAt < MAX_LIFETIME_MS) {
        const rows = await all<{ id: number; eventType: string; message: string; severity: string; metadataJson: string; createdAt: string }>(
          env,
          `SELECT id, event_type AS eventType, message, severity, metadata_json AS metadataJson, created_at AS createdAt
             FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
          [runId, cursor],
        );
        for (const row of rows) {
          cursor = row.id;
          send("run_event", row);
        }
        const statusRow = await first<{ status: string }>(env, "SELECT status FROM runs WHERE id = ?", [runId]);
        if (statusRow && statusRow.status !== lastStatus) {
          lastStatus = statusRow.status;
          send("status", { status: lastStatus });
        }
        if (statusRow && TERMINAL.has(statusRow.status)) {
          send("done", { status: statusRow.status });
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p worker/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(api): SSE stream for run events"
```

---

## Task 11: Memory forward-compat seam (pure, TDD)

**Files:**
- Create: `worker/src/platform/run-summary.ts`
- Test: `tests/run-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { summarizeRunForMemory } from "../worker/src/platform/run-summary";

describe("summarizeRunForMemory", () => {
  it("produces a structured memory record from a run + events + result", () => {
    const out = summarizeRunForMemory(
      { id: "run_1", objective: "Add X", projectName: "Proj", status: "completed" },
      [{ eventType: "agent.start", message: "" }, { eventType: "pr.opened", message: "#42" }],
      { ok: true, prUrl: "https://github.com/o/r/pull/42", summary: "did the thing" },
    );
    expect(out.bankKey).toBe("Proj");
    expect(out.content).toContain("Add X");
    expect(out.outcome).toBe("completed");
    expect(out.context.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(out.context.eventTypes).toContain("pr.opened");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/* AGPL-3.0-or-later */

// Forward-compat seam for the future Hindsight memory integration. Produces a
// structured run outcome suitable for a `retain(bank, content, context, ts)` call.
// UNUSED until the memory workstream wires it up — do not delete.
export interface RunForSummary {
  id: string;
  objective: string;
  projectName: string | null;
  status: string;
}
export interface EventForSummary {
  eventType: string;
  message: string;
}
export interface ResultForSummary {
  ok?: boolean;
  prUrl?: string;
  summary?: string;
  error?: string;
}
export interface MemoryRecord {
  bankKey: string;
  content: string;
  outcome: string;
  context: { runId: string; prUrl?: string; error?: string; eventTypes: string[] };
}

export function summarizeRunForMemory(
  run: RunForSummary,
  events: EventForSummary[],
  result: ResultForSummary,
): MemoryRecord {
  return {
    bankKey: run.projectName ?? "default",
    content: `Objective: ${run.objective}\nOutcome: ${run.status}\n${result.summary ?? result.error ?? ""}`.trim(),
    outcome: run.status,
    context: {
      runId: run.id,
      prUrl: result.prUrl,
      error: result.error,
      eventTypes: events.map((e) => e.eventType),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/platform/run-summary.ts tests/run-summary.test.ts
git commit -m "feat(memory): summarizeRunForMemory forward-compat seam"
```

---

## Task 12: Event-style mapping (pure, TDD)

**Files:**
- Create: `src/lib/event-style.ts`
- Test: `tests/event-style.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { eventColor } from "../src/lib/event-style";

describe("eventColor", () => {
  it("maps by event-type prefix", () => {
    expect(eventColor("clone.start")).toBe(eventColor("clone.done"));
    expect(eventColor("agent.output")).toBe("#7ee787");
    expect(eventColor("pr.opened")).toBe("#d2a8ff");
    expect(eventColor("memory.recall")).toBe("#79c0ff");
  });
  it("falls back to a default for unknown prefixes", () => {
    expect(eventColor("weird.thing")).toBe("#8b949e");
    expect(eventColor("")).toBe("#8b949e");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/event-style.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/* AGPL-3.0-or-later */

// Terminal-log accent color per event-type prefix. Open set: a new prefix (e.g.
// memory.*) just needs an entry; unknowns get the neutral default.
const PREFIX_COLORS: Record<string, string> = {
  clone: "#58a6ff",
  agent: "#7ee787",
  tests: "#f2cc60",
  push: "#ffa657",
  pr: "#d2a8ff",
  memory: "#79c0ff",
  run: "#8b949e",
  container: "#58a6ff",
  heartbeat: "#484f58",
};

export function eventColor(eventType: string): string {
  const prefix = eventType.split(".")[0] ?? "";
  return PREFIX_COLORS[prefix] ?? "#8b949e";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/event-style.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-style.ts tests/event-style.test.ts
git commit -m "feat(ui): pure event-type color mapping"
```

---

## Task 13: AppShell + route

**Files:**
- Create: `src/AppShell.tsx`
- Modify: `src/router.tsx`

- [ ] **Step 1: Create the AppShell**

```tsx
/* AGPL-3.0-or-later */
import { AppShell, NavLink, Title, Group, Box } from "@mantine/core";
import { IconDashboard, IconActivityHeartbeat } from "@tabler/icons-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AppShell navbar={{ width: 220, breakpoint: "sm" }} padding="md">
      <AppShell.Navbar p="md">
        <Box mb="lg">
          <Title order={4}>Fly Dev</Title>
        </Box>
        <NavLink
          component={Link}
          to="/"
          label="Dashboard"
          leftSection={<IconDashboard size={18} />}
          active={pathname === "/"}
        />
        <NavLink
          component={Link}
          to="/command-center"
          label="Command Center"
          leftSection={<IconActivityHeartbeat size={18} />}
          active={pathname === "/command-center"}
        />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
```

- [ ] **Step 2: Wire the router to use the layout + new route**

Replace `src/router.tsx`:

```tsx
/* AGPL-3.0-or-later */
import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { App } from "@/App";
import { RootLayout } from "@/AppShell";
import { CommandCenter } from "@/CommandCenter";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});

const commandCenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/command-center",
  component: CommandCenter,
});

const routeTree = rootRoute.addChildren([indexRoute, commandCenterRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

- [ ] **Step 3: Verify `@mantine/core` AppShell + `@tabler/icons-react` are installed**

Run: `grep -n "@mantine/core\|@tabler/icons-react" package.json`
Expected: both present (they are, per the existing App.tsx imports). If `useRouterState` is unavailable in the installed router version, fall back to `window.location.pathname`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit` (or `npm run build` once CommandCenter exists in Task 14)
Expected: fails only on missing `CommandCenter` import until Task 14. Proceed.

- [ ] **Step 5: Commit**

```bash
git add src/AppShell.tsx src/router.tsx
git commit -m "feat(ui): AppShell with Dashboard + Command Center nav"
```

---

## Task 14: CommandCenter + RunCard

**Files:**
- Create: `src/CommandCenter.tsx`, `src/RunCard.tsx`

- [ ] **Step 1: Create RunCard**

```tsx
/* AGPL-3.0-or-later */
import { useEffect, useRef, useState } from "react";
import { Card, Group, Text, Badge, Button, ScrollArea, Box } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { eventColor } from "@/lib/event-style";

interface RunEvent { id: number; eventType: string; message: string; createdAt: string }
export interface ActiveRun { id: string; objective: string; status: string; projectName: string | null }

const STATUS_COLOR: Record<string, string> = {
  running: "teal", starting: "indigo", queued: "gray", failed: "red", completed: "teal", cancelled: "gray",
};

export function RunCard({ run }: { run: ActiveRun }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState(run.status);
  const viewport = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    // Local dev injects x-fly-user via fetchJson, but EventSource can't set headers.
    // In production the session cookie authenticates; in local dev append the marker.
    const isLocal = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    const url = `/api/runs/${run.id}/events/stream${isLocal ? "?x-fly-user=local-dev" : ""}`;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener("run_event", (e) => {
      const row = JSON.parse((e as MessageEvent).data) as RunEvent;
      setEvents((prev) => [...prev.slice(-199), row]);
    });
    es.addEventListener("status", (e) => setStatus((JSON.parse((e as MessageEvent).data) as { status: string }).status));
    es.addEventListener("done", () => es.close());
    return () => es.close();
  }, [run.id]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [events]);

  const cancel = useMutation({
    mutationFn: () => fetchJson(`/api/runs/${run.id}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["active-runs"] }),
  });

  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Text fw={600} truncate>{run.objective}</Text>
        <Badge color={STATUS_COLOR[status] ?? "gray"}>{status}</Badge>
      </Group>
      {run.projectName && <Text size="xs" c="dimmed" mb="xs">{run.projectName}</Text>}
      <ScrollArea h={200} viewportRef={viewport} mb="xs">
        <Box style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, background: "#0d1117", padding: 8, borderRadius: 6 }}>
          {events.length === 0 && <Text size="xs" c="dimmed">Waiting for live output…</Text>}
          {events.map((ev) => (
            <div key={ev.id} style={{ color: eventColor(ev.eventType), whiteSpace: "pre-wrap" }}>
              <span style={{ opacity: 0.6 }}>{ev.eventType}</span> {ev.message}
            </div>
          ))}
        </Box>
      </ScrollArea>
      <Group justify="flex-end">
        <Button size="xs" color="red" variant="light" loading={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      </Group>
    </Card>
  );
}
```

- [ ] **Step 2: Create CommandCenter**

```tsx
/* AGPL-3.0-or-later */
import { SimpleGrid, Title, Text, Loader, Center, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { RunCard, type ActiveRun } from "@/RunCard";

interface Overview { recentRuns: Array<ActiveRun & { createdAt: string }> }

export function CommandCenter() {
  const query = useQuery({
    queryKey: ["active-runs"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
    refetchInterval: 5000,
  });

  const active = (query.data?.recentRuns ?? []).filter((r) =>
    ["starting", "queued", "running"].includes(r.status),
  );

  return (
    <Stack>
      <Title order={2}>Command Center</Title>
      {query.isLoading && <Center><Loader /></Center>}
      {!query.isLoading && active.length === 0 && (
        <Text c="dimmed">No active runs. Queued and running runs appear here live.</Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {active.map((run) => <RunCard key={run.id} run={run} />)}
      </SimpleGrid>
    </Stack>
  );
}
```

- [ ] **Step 3: Build the frontend + worker typecheck**

Run: `npm run build`
Expected: Vite build succeeds and `tsc` passes (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/CommandCenter.tsx src/RunCard.tsx
git commit -m "feat(ui): Command Center grid with live-streaming RunCards"
```

---

## Task 15: Full test + manual local verification

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all tests pass, including the 4 new test files.

- [ ] **Step 2: Manual local smoke (optional but recommended)**

Run: `npm run dev`, open `http://localhost:5173/command-center`. Expected: page renders under the sidebar; with no active runs it shows the empty state. (Full container streaming is verified post-deploy in Task 16.)

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test: verification fixups for command center" || echo "nothing to fix up"
```

---

## Task 16: Production unstick + deploy + verify

This task makes real production changes (user authorized "Full").

- [ ] **Step 1: Reset the current zombie `running` rows so the gate reopens**

Runs that already exhausted their redispatch budget → `failed`; the rest → `queued`. Conservative single statement (re-queue all currently-stuck active rows; the new reaper/budget will fail any that keep stalling):

Run:
```bash
wrangler d1 execute fly-dev --remote --command "UPDATE runs SET status='queued', started_at=NULL, last_heartbeat_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE status IN ('running','starting')"
```
Expected: ~10 rows changed.

- [ ] **Step 2: Apply the migration to remote D1**

Run: `wrangler d1 migrations apply fly-dev --remote`
Expected: applies `0023_run_heartbeat.sql`.

- [ ] **Step 3: Deploy the worker + rebuild the container image**

Run: `wrangler deploy`
Expected: build of `./container/Dockerfile`, push, and worker upload all succeed.

- [ ] **Step 4: Verify the gate reopened and runs progress**

Run:
```bash
wrangler d1 execute fly-dev --remote --json --command "SELECT status, COUNT(*) n FROM runs GROUP BY status"
```
Expected over a few minutes: `queued` count falling, `running` ≤ 8 with fresh `last_heartbeat_at`, some `completed`.

- [ ] **Step 5: Verify live events arrive for one run**

Run (replace with a currently-active id):
```bash
wrangler d1 execute fly-dev --remote --json --command "SELECT event_type, created_at FROM run_events WHERE run_id='<id>' ORDER BY id DESC LIMIT 10"
```
Expected: more than just `container.start` — `container.ready`, `clone.start`, `agent.start`, `heartbeat`, etc.

- [ ] **Step 6: Confirm in the UI**

Open `https://dev.fly.pm/command-center`. Expected: active runs render as cards with live terminal output streaming.

- [ ] **Step 7: Final commit / push branch**

```bash
git push -u origin feat/command-center-live-view
```

---

## Self-review notes

- **Spec coverage:** streaming (Tasks 6, 9), heartbeats (Tasks 3, 9), `starting`/fail-fast (Tasks 4, 5), reaper (Tasks 2, 7), SSE (Task 10), Command Center UI (Tasks 12–14), ops (Task 16), forward-compat seams (Task 11 + free-form event types/prefix coloring in Task 12). All spec sections map to tasks.
- **Watch items flagged inline:** `isFreshTimestamp` epoch units (Task 9 Step 1); `reapKind` handling of `starting` (Task 7 Step 2); `useRouterState` availability (Task 13 Step 3); `EventSource` auth in local dev (Task 14 Step 1).
- **Out of scope confirmed:** real pause, full sidebar IA, gh-pages perf board, Hindsight wiring.
