# fly-dev v2 — autonomous dev platform design

Status: design draft (2026-06-06). Supersedes the ad-hoc run pipeline. This is the
target architecture agreed across the v2 brainstorm: a modular, self-learning,
autonomous dev system where humans direct and review, and the system does the grind.

## Principles (the non-negotiables this design enforces)
1. **Don't rewrite what works.** The Cloudflare Worker control plane (Hono, Workflows,
   Durable Objects, Queues, D1) stays TypeScript and Cloudflare-native. Rust is used
   *surgically* where it removes real opacity — the agent execution core — not at the edge.
2. **Truth over transcript.** Every unit of work produces a *typed Outcome*, never
   stdout to be regex'd. This is the root fix for "no_changes vs failed" and the UX.
3. **Run status ≠ reality.** The platform continuously reconciles its records against
   the actual repos + Linear. "failed" must never mean "undone" when the work shipped.
4. **Autonomy = pulse + character + conscience.** Memory alone is automation. The
   system gets a heartbeat (agency), a soul.md (identity/values/guardrails), and a
   feedback loop (learning from human correction).
5. **Secrets: Doppler is the single source of truth.** Everything else syncs from it.

## The three planes
```
                    ┌────────────────────────── Cognition plane ──────────────────────────┐
                    │  HINDSIGHT (self-hosted, GCP)                                         │
                    │  retain · recall · reflect · observations+consolidation · mental      │
                    │  models · MCP server. Banks: world / per-project / per-workflow.      │
                    └───────────▲───────────────────────────────────────────┬──────────────┘
                                │ recall / retain / reflect                  │ learned routing,
                                │                                            │ mental models
┌───────────── Control plane (TS, Cloudflare) ─────────────┐    ┌───────────▼───────── Execution plane ─────────┐
│ Hono API · Workflows · DOs · Queues · D1                 │    │ Agent core (Rust + Rig, in the Container)      │
│ HEARTBEAT (scheduled pulse) · ranker · reconciliation    │───▶│ typed Job → Outcome                            │
│ soul.md + guardrails (policy) · feedback ingestion       │◀───│ pluggable Executors (failover + routing)       │
│ Doppler-synced secrets · dashboard (state model)         │    │ MCP tools · Skills (workflows)                 │
└──────────────────────────────────────────────────────────┘    └────────────────────────────────────────────────┘
```

## Core contracts (the spine that keeps this from sprawling)
- **`Job`** — a typed unit of work: `{ objective, project, workflow_kind, repo, constraints }`
  where `constraints` are derived from soul.md + guardrails (scope, spend cap, "never prod").
- **`Outcome`** — a typed result, the ONLY thing the agent returns:
  `Shipped{pr,commit} | NoChange{reason} | Blocked{cause, whose_move} | Insight{findings} | Failed{class}`.
  Retained to Hindsight + drives the UI state model directly (no parsing).
- **`Executor`** (Rust trait) — runs a `Job` via one backend. Implementations: `claude-code`,
  `codex`, `gemini-cli`, `ai-gateway`. The router picks order from **Hindsight-learned
  model↔task fit**; failover walks the list on timeout/rate-limit/error.
- **`Skill`** — a versioned, testable packaged workflow (testing/security/perf/insight) that
  *produces Jobs and consumes Outcomes*. Workflows are skills, not ad-hoc pipelines.

## The learning closure (why this is self-learning, not self-remembering)
```
heartbeat tick
  → reflect(Hindsight) + ranker  → choose workflow + Job (aligned to soul.md/macro)
  → router (Hindsight-learned)   → pick Executor; recall injected; MCP tools; guardrails enforced
  → Executor runs               → typed Outcome
  → retain(Outcome) + reconcile against repo/Linear
  → observations consolidate    → mental models refresh
  → informs the next tick's reflect + routing
```
Crucially, **Outcome includes which model did what, how well** → consolidation turns that into
the routing prior. The performance workflow is both a benchmark *and* the data source that
teaches the router. Human feedback (PR review, rejections) is retained as memory too, so the
loop has a conscience, not just outcomes.

## Component specs

### soul.md (identity / values / guardrails)
Versioned in-repo. Encodes: what "done" means, the quality + security bar, tone, what to
*never* do, and the **authority policy** with teeth — spend caps, repo-write scope, prod
boundaries, what runs unattended vs. must ask. Every `Job.constraints` is derived from it.
This is the macro that reconciliation measures the micro against.

### Heartbeat (agency)
A control-plane scheduled pulse (Workflow/cron + a DO holding pulse state). Each tick:
reconciles state, runs `reflect` for insight, asks the **ranker** "what's most valuable
next," dispatches the highest-value workflow Jobs within budget, and reports. This is the
line between *triggered* and *autonomous*. Bounded by soul.md guardrails + a global kill-switch.

### Hindsight — full loop, not just memory
- Bank topology: a global **world** bank (general dev knowledge), **per-project experience**
  banks, **per-workflow** banks (testing/security/perf/insight playbooks).
- Use `reflect` as the **insight workflow** engine; `observations`+auto-consolidation for
  maturation; **mental models** as living per-project/per-workflow playbooks injected at recall.
- Tuned disposition/missions per bank (e.g. high-skepticism security bank).
- Exposed to the agent core as an **MCP server** (already supported — `mcp:true`).

### Executors + dynamic failover (the reliable shell)
Four backends behind one trait: `claude-code` (OAuth), `codex` (gateway), `gemini-cli` (key),
`ai-gateway` (dynamic routes). Auth is normalized per backend, sourced ephemerally from
Doppler→control-plane→run payload (never baked in). Router order = learned fit; failover on
fault. The gateway's known flakiness (dynamic-route/BYOK/embed issues) is *absorbed* here,
not "fixed first" — failover is the resilience layer.

### Specialized workflows (as skills)
- **Testing** — find under-covered surfaces; propose/add tests.
- **Security** — proactively find + fix *our own* vulns (defensive/dual-use kept defensive).
- **Performance** — run the SAME Job across all executors; score via objective signals
  (tests/CI/PR-merged) + `reflect` for qualitative judgment; *feeds the router*. Sampled
  cadence, not every run (cost).
- **Insight** — `reflect` over memory + an **async research agent** (scheduled deep-research,
  retaining to an "opportunities" bank) → patterns, next steps, OSS/market signals.

### MCP — the tool/integration substrate
Standard interface for tools: Hindsight-as-MCP (memory), GitHub, Linear, search, Sentry, etc.
Rig consumes MCP tools. New integrations = add an MCP server, not a bespoke adapter.

### Feedback ingestion (conscience)
PR review comments, human rejections, and "this was wrong" signals are captured and retained
to Hindsight as corrective memories → the system learns from correction, not just outcomes.

### Reconciliation (micro ↔ macro)
Continuous cross-check: each Job's objective vs. merged PR / closed Linear issue. A "failed"
run whose work shipped renders "✅ shipped (elsewhere)" and closes the loop — never "needs you."
Runs on the heartbeat. Seeds Hindsight with *truth*, not phantom failures.

### Secrets — Doppler as source of truth
- **Doppler** (`quickapp` project) is canonical. Sync outward:
  - Cloudflare Worker secrets ← Doppler **Cloudflare Workers integration** (or CI sync), not
    manual `wrangler secret put` drift.
  - GCP VM (Hindsight) ← `doppler run` / a Doppler **service token** rendering env at boot
    (replaces the static `/opt/hindsight/.env`).
  - Execution plane ← ephemeral, run-scoped secrets passed by the control plane (sourced from
    Doppler), never in the image.
- **Boundary to document:** BYOK provider keys for the AI Gateway live in **Cloudflare Secret
  Store** (independent of Doppler by design); Doppler remains the *record of which keys exist*
  and their rotation owner, with the live value in Secret Store.

## What we keep / refactor / add (grounded in today's code)
- **Keep:** the Hono router, RunWorkflow, queue/admission gate, DO classes, D1 schema,
  Hindsight integration (already live), the AI Gateway routing.
- **Refactor:** the container's `server.mjs` opaque CLI shell-out → the Rust/Rig agent core
  emitting typed Outcomes (incrementally; wrap the CLIs as Executors first).
- **Add:** soul.md + guardrail policy, heartbeat + ranker, reconciliation pass, feedback
  ingestion, the Executor/Skill/Job contracts, Doppler sync, the UX state model (whose-move axis).

## Phased build plan (each phase shippable + reversible)
0. **Reconciliation pass** — non-destructive; turn 96 phantom failures into truth, seed
   Hindsight from reality. (Highest value, informs everything.)
1. **Contracts + Doppler + soul.md** — `Job`/`Outcome`/`Executor` (TS-side first), Doppler
   sync, soul.md + guardrail policy. Wrap existing CLIs as Executors with failover.
2. **Typed Outcomes + UX state model** — kill stdout parsing; render whose-move axis,
   de-amplified retries, reconciliation status, produced artifacts.
3. **Hindsight full loop** — reflect, mental models, per-workflow banks, the routing prior.
4. **Heartbeat + Performance workflow** — the pulse + the workflow that bootstraps routing data.
5. **Remaining workflows as skills + feedback loop + research agent + MCP substrate.**
6. **Rust/Rig agent core** — replace the CLI Executors with a native typed agent (last, once
   the contracts are proven).

## Open decisions for sign-off
- **Rig-on-Workers vs Rust-in-container:** design assumes Rust agent core in the *container*
  (full Tokio), control plane stays TS. Confirm we're not chasing all-Rust-on-Workers.
- **soul.md scope:** one org-level soul, or per-project overrides? (Recommend org soul +
  per-project addenda.)
- **Heartbeat authority:** how much may it dispatch unattended within budget before asking?
- **Performance workflow cost cadence:** how often do we pay the ×4-model comparison?
