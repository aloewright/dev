# Command Center live-view + execution un-deadlock — Design

Date: 2026-06-05
Status: Approved (pending spec review)

## Problem

Orchestration runs get marked `running` the instant the worker *requests* a sandbox
container, then the container's `/run` POST holds open for the entire pipeline and
streams **nothing** back. Consequences:

1. **No visibility.** The only signal a run emits while executing is the single
   `container.start` event; everything else is `console.log` that reaches only
   `wrangler tail`. The UI shows one-shot `/api/overview` data and cannot show a
   live run.
2. **Capacity deadlock.** A slow or hung run holds a `running` slot for up to **110
   minutes** before the reaper requeues it. The queue consumer refuses to dispatch
   while `getActiveRunCount() >= MAX_CONTAINER_INSTANCES` (8). Once ≥8 runs pile into
   `running`, the gate latches shut and every `queued` task starves indefinitely.
   Observed live: 10 `running` (over the cap of 8), 53 `queued`, 33 `failed`.

The container image is deployed and *some* runs complete — this is a liveness /
visibility problem, not a dead image.

## Goals

- Stream per-run progress from the container to the worker so the UI can render a
  live view and the worker can detect liveness.
- Make the capacity gate immune to not-yet-ready and stalled runs so the queue
  cannot deadlock.
- Add a **Command Center** page: a grid of live cards, one per active run, each
  showing a streamed terminal log + status + actions.
- Unstick the current production queue and deploy.

## Non-goals (YAGNI)

- Real container pause/resume (the mockup's "Pause" is relabeled **Cancel**).
- Full sidebar IA — only **Dashboard** and **Command Center** links.
- Log persistence beyond the existing `run_events` table.
- Hindsight memory integration (separate future workstream — see Forward
  compatibility).

## Architecture

### 1. Container → worker event streaming (keystone)

`container/server.mjs` gains an `emit(eventType, message, severity, meta)` helper that
POSTs to a new HMAC-gated worker endpoint:

```
POST /api/internal/runs/:id/events
headers: x-fly-internal-signature: <hmac-sha256 of body using INTERNAL_HMAC_SECRET>
body: { eventType, message, severity, metadata }
```

- Reuses the existing internal-HMAC scheme used by `/api/internal/status`.
- The worker base URL + internal secret are passed to the container in the existing
  `/run` request body (`callbackBaseUrl`, `callbackSecret`).
- The worker handler verifies the signature, calls `recordRunEvent(...)`, and bumps a
  new `runs.last_heartbeat_at` column to `CURRENT_TIMESTAMP`.

Events emitted by the container, in order: `clone.start`, `clone.done`, `analyze`,
`agent.start`, throttled `agent.output` (parsed from claude-code stream-json — the
ANALYSIS/PLAN/ACT/VALIDATE lines), `tests`, `push`, `pr.opened`, terminal
`agent.result`. Plus a `heartbeat` every ~15s on a timer for the whole `/run`
duration. `agent.output` is throttled to at most ~1 event/second and truncated to a
sane length to avoid flooding D1.

Network note: the container has `enableInternet=false` + an `allowedHosts` allowlist.
The worker callback host (the fly-dev worker origin) MUST be added to `allowedHosts`
so the container can reach the ingest endpoint.

### 2. Un-deadlock (worker)

- **`starting` status.** A run reserved for dispatch flips to a new transient
  `starting` status (not `running`). `getActiveRunCount()` counts BOTH `starting`
  and `running` toward capacity (so we never over-subscribe the 8 slots), but the run
  only becomes `running` after `startAndWaitForPorts` succeeds. A container that never
  becomes ready is failed-fast (below) rather than stranded.
- **Fail-fast.** The container start + dispatch steps in `RunWorkflow.run()` are
  wrapped so a throw marks the run `failed` (with a retryable error) immediately and
  frees its slot — no row is left stranded in `starting`/`running`.
- **Heartbeat reaper.** Replace the 110-minute "stuck running" rule in
  `reapStuckRuns()` with:
  `status IN ('running','starting') AND last_heartbeat_at <= now-8min → stalled` →
  requeue via the existing redispatch budget. Live runs heartbeat every 15s so they
  are never reaped; genuinely hung runs recover in ~8 min. `last_heartbeat_at` is set
  to `started_at` (or now) on transition so a just-started run gets a fresh window.
- Migration `migrations/0023_run_heartbeat.sql`: `ALTER TABLE runs ADD COLUMN
  last_heartbeat_at TEXT;` and an index on `(status, last_heartbeat_at)`.

### 3. SSE endpoint (worker)

`GET /api/runs/:id/events/stream` → `text/event-stream`. Implemented as a
`ReadableStream` that:

- Authenticates via the existing `requireUser()` and authorizes the run belongs to
  the user.
- Polls D1 every ~1.5s for `run_events` with `id > cursor`, emits each as an SSE
  `data:` frame, advances the cursor.
- Emits a `status` frame whenever the run's status changes.
- Closes the stream when the run reaches a terminal status (`completed`/`failed`/
  `cancelled`) or after a max lifetime (e.g. 15 min) so the socket cannot leak.

Active-run list for the grid reuses `/api/overview` filtered to
`status IN ('starting','queued','running')` (no new endpoint required; if the
overview payload is too heavy, add a slim `GET /api/active-runs`).

### 4. Frontend Command Center (`src/`)

- New route `/command-center` in `src/router.tsx`.
- A lightweight Mantine **AppShell** with a sidebar holding two links: **Dashboard**
  (`/`) and **Command Center** (`/command-center`). The existing single-page `App`
  moves under the shell's main slot for `/`.
- Command Center renders a `SimpleGrid` of `RunCard`s, one per active run (fetched via
  react-query against the active-run list, `refetchInterval` ~5s to add/remove cards).
- `RunCard`:
  - Header: objective (truncated), project name, `StatusBadge`.
  - **Live log**: subscribes to `/api/runs/:id/events/stream` via `EventSource`,
    keeps the last N (~200) events, renders a neon-on-dark terminal panel, color-coded
    by `event_type` **prefix** (`clone.*`, `agent.*`, `tests.*`, `push.*`, `pr.*`,
    `memory.*`, `run.*`). Auto-scrolls to the newest line.
  - Footer actions wired to existing mutations: **Cancel** (`POST /api/runs/:id/cancel`),
    and **Approve**/**Retry** shown contextually by status. No "Pause".
  - Closes its `EventSource` on unmount and on terminal status.
- Styling: Mantine dark theme + Tailwind utilities for the terminal panel
  (monospace, dark bg, per-prefix accent colors).

### 5. Ops

- One-time: reset the current stuck `running` rows so the gate reopens immediately
  (the new reaper would also catch them, but unstick now). Runs that already exhausted
  their budget → `failed`; others → `queued`.
- `wrangler deploy` from the worker to ship the new code and rebuild the container
  image (which now includes the heartbeat emitter).

## Data flow

```
queue msg ─▶ consumer (gate: starting+running < 8)
          ─▶ RunWorkflow: status=starting
          ─▶ startAndWaitForPorts ──fail──▶ status=failed (retryable), slot freed
                    │ ok
                    ▼ status=running, last_heartbeat_at=now
          ─▶ container.fetch(/run) ───────────────────────────────┐
                                                                   │ during run
   container.emit(...) ─▶ POST /api/internal/runs/:id/events ◀─────┘
                          └▶ recordRunEvent + bump last_heartbeat_at
          ◀─ final ContainerRunResult ─▶ status=completed/failed

UI RunCard ─▶ EventSource GET /api/runs/:id/events/stream
           ◀─ SSE frames (events + status) until terminal
```

## Error handling

- Container cannot reach the callback (allowedHosts misconfig): run still completes
  via the final blob; absence of heartbeats means the reaper requeues it after 8 min —
  acceptable degradation, surfaced as a stalled-run event.
- SSE poll error: stream emits an `error` frame and closes; the client reconnects via
  `EventSource` default retry.
- HMAC mismatch on ingest: 401, event dropped, logged.

## Testing

- Worker unit tests (vitest): stalled-heartbeat reaper detection; capacity counter
  includes `starting`; HMAC verify on the internal ingest (valid/invalid/missing);
  status transition `starting`→`running` only after ports ready; fail-fast marks
  failed.
- Container: unit test for the `emit` throttle/truncation helper.
- Frontend: a DOM test for `RunCard` rendering a sequence of streamed events and
  color-coding by prefix.

## Forward compatibility (Hindsight, later)

Hindsight is an agent **memory** system (retain/recall/reflect), not observability;
it does not replace the Command Center. Two no-cost seams now:

1. `summarizeRunForMemory(run, events, result)` — a single structured run-outcome
   object (objective, plan, actions, diff/PR, outcome, errors). Defined and unit-
   shaped now, unused until the memory workstream calls `retain(...)`.
2. Free-form `event_type` + prefix-based log coloring means future
   `memory.recall` / `memory.retain` / `memory.reflect` events stream into the same
   Command Center with no schema or UI change.

A gh-pages-style perf board for orchestrator runs (mirroring
hindsight-continuous-performance-monitor) is explicitly out of scope.
