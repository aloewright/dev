# Model Policy

## Coding agents (sandbox selectable)

**Primary model:** `claude-sonnet-4-6`
**Flags:** `--model claude-sonnet-4-6 --effort medium`

Used in `container/server.mjs` `agentCommand()` when the run selects `claude-code`. Sonnet 4.6 at medium effort balances quality and cost for high-volume, parallelisable coding tasks (feature branches, test fixes, conflict resolution). At potentially hundreds of runs per day, the lower token cost and faster latency of Sonnet vs. Opus are material.

**User-selectable options:** the UI can create runs with `claude-code`, `codex`, or `cloudflare`.

- `claude-code` runs Claude Code first, then falls back to Codex on Claude usage limits.
- `codex` runs the Codex CLI on `openai/gpt-5.5` through Cloudflare AI Gateway.
- `cloudflare` runs the Codex CLI on Workers AI `@cf/openai/gpt-oss-120b` through Cloudflare AI Gateway.

**Failover:** Codex CLI via Cloudflare AI Gateway `openai/gpt-5.5`

When Claude Code reports a subscription usage limit, `container/server.mjs` re-runs the same prompt through Codex. Codex is configured per run with a transient `CODEX_HOME/config.toml` that points at Cloudflare's REST Responses endpoint, `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1`, using `wire_api = "responses"` and gateway id `x`. The gateway token stays in subprocess environment variables and is not written into the config file.

Codex 0.139+ rejects the old chat wire API. Cloudflare dynamic routes are still exposed through `/compat/chat/completions`, so the failover uses the live-verified Responses path with `openai/gpt-5.5` until dynamic routes support Responses.

## Supervisor agent (not yet built)

**Supervisor:** gemini-3.1-pro via Google Vertex AI, routed through the Cloudflare AI Gateway (BYOK, regional endpoint us-central1).

The supervisor's in-Worker LLM calls run on **Gemini 3.1 Pro served by Google Vertex AI, ROUTED THROUGH the Cloudflare AI Gateway** — honoring the house rule (route through the gateway; never call providers directly). Vertex is a first-class gateway provider; with **BYOK** the GCP service-account JSON is stored in the gateway's Provider Keys (+ region), so the gateway injects Google's credentials and app code only sends the gateway auth — no provider key. In-Worker mechanism is the Universal-endpoint binding form `env.AI.gateway(id).run({ provider: "google-vertex-ai", endpoint: ".../gemini-3.1-pro:generateContent", query })` against the **regional** endpoint `us-central1` (`global` has limited model support); responses are parsed as `candidates[0].content.parts[].text`. The supervisor orchestrates coding agents, evaluates their output, decides whether a PR is mergeable, and handles escalation — tasks that require deep reasoning and judgment rather than throughput — and it runs infrequently (once per run, not per agent turn).

## Summary table

| Role | Model | Routing | Why |
|---|---|---|---|
| Coding agent (sandbox) | `claude-sonnet-4-6`, `openai/gpt-5.5`, or `@cf/openai/gpt-oss-120b` | Claude OAuth or Codex CLI via Cloudflare AI Gateway REST Responses | User-selected coding runtime |
| Supervisor (planned) | `gemini-3.1-pro` (Google Vertex AI) | via Cloudflare AI Gateway (BYOK, regional `us-central1`) | Low volume, correctness critical |
