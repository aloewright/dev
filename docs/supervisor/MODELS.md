# Model Policy

## Coding agents (sandbox `claude-code`)

**Model:** `claude-sonnet-4-6`
**Flags:** `--model claude-sonnet-4-6 --effort medium`

Used in `container/server.mjs` `agentCommand()` for every sandbox coding run. Sonnet 4.6 at medium effort balances quality and cost for high-volume, parallelisable coding tasks (feature branches, test fixes, conflict resolution). At potentially hundreds of runs per day, the lower token cost and faster latency of Sonnet vs. Opus are material.

## Supervisor agent (not yet built)

**Model:** `claude-opus-4-8`
**Intended flags:** `--model claude-opus-4-8 --effort high` (ultracode / high reasoning)

Recorded here for when `SupervisorAgent` is implemented. The supervisor orchestrates coding agents, evaluates their output, decides whether a PR is mergeable, and handles escalation — tasks that require deep reasoning and judgment rather than throughput. Opus 4.8 with high effort is the right trade-off: it runs infrequently (once per run, not per agent turn), so the higher cost is acceptable, and the quality uplift directly affects correctness of the overall pipeline.

## Summary table

| Role | Model | Effort | Why |
|---|---|---|---|
| Coding agent (sandbox) | `claude-sonnet-4-6` | `medium` | High volume, cost/latency sensitive |
| Supervisor (planned) | `claude-opus-4-8` | `high` | Low volume, correctness critical |
