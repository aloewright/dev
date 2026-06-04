# Model Policy

## Coding agents (sandbox `claude-code`)

**Model:** `claude-sonnet-4-6`
**Flags:** `--model claude-sonnet-4-6 --effort medium`

Used in `container/server.mjs` `agentCommand()` for every sandbox coding run. Sonnet 4.6 at medium effort balances quality and cost for high-volume, parallelisable coding tasks (feature branches, test fixes, conflict resolution). At potentially hundreds of runs per day, the lower token cost and faster latency of Sonnet vs. Opus are material.

## Supervisor agent (not yet built)

**Supervisor:** gemini-3.1-pro via Google Vertex AI, routed through the Cloudflare AI Gateway (BYOK, regional endpoint us-central1).

The supervisor's in-Worker LLM calls run on **Gemini 3.1 Pro served by Google Vertex AI, ROUTED THROUGH the Cloudflare AI Gateway** — honoring the house rule (route through the gateway; never call providers directly). Vertex is a first-class gateway provider; with **BYOK** the GCP service-account JSON is stored in the gateway's Provider Keys (+ region), so the gateway injects Google's credentials and app code only sends the gateway auth — no provider key. In-Worker mechanism is the Universal-endpoint binding form `env.AI.gateway(id).run({ provider: "google-vertex-ai", endpoint: ".../gemini-3.1-pro:generateContent", query })` against the **regional** endpoint `us-central1` (`global` has limited model support); responses are parsed as `candidates[0].content.parts[].text`. The supervisor orchestrates coding agents, evaluates their output, decides whether a PR is mergeable, and handles escalation — tasks that require deep reasoning and judgment rather than throughput — and it runs infrequently (once per run, not per agent turn).

## Summary table

| Role | Model | Routing | Why |
|---|---|---|---|
| Coding agent (sandbox) | `claude-sonnet-4-6` | `--effort medium` | High volume, cost/latency sensitive |
| Supervisor (planned) | `gemini-3.1-pro` (Google Vertex AI) | via Cloudflare AI Gateway (BYOK, regional `us-central1`) | Low volume, correctness critical |
