# Fly Dev Orchestrator

Cloudflare-native orchestration surface for the fly.pm app family, hosted at `dev.fly.pm`.

## What it does

- Tracks fly users, GitHub/Linear connections, usage events, project mappings, runs, artifacts, approvals, and agent memories in D1.
- Uses Cloudflare Durable Objects, Queues, Workflows, Containers, R2, KV, AI Gateway, Browser Rendering, and Workers for Platforms dispatch namespaces.
- Exposes an operations dashboard plus APIs for user tasks, internal fly.pm status checks, one-off deploy requests, OAuth connections, webhooks, and template app creation.
- Keeps Linear as the project source of truth and maps Linear projects to GitHub repositories with confidence scoring.
- Preserves CLI execution as the sandbox model: Codex CLI and Claude Code run inside a Cloudflare Container with an explicit allowlist.

## Local development

```sh
bun install
bun run migrate:local
bun run dev
```

The Vite app runs on `127.0.0.1:5173` and proxies `/api` to the Worker on `127.0.0.1:8787`.

## Verification

```sh
bun run typecheck
bun run test
bun run build
bun run cf:dry-run
```

`wrangler.jsonc` contains the production D1/KV bindings created for `fly-dev`; credentials and signing keys should be set with Wrangler secrets.

## Required secrets

- `TOKEN_ENCRYPTION_KEY`
- `INTERNAL_API_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `LINEAR_CLIENT_ID`
- `LINEAR_CLIENT_SECRET`
- `LINEAR_WEBHOOK_SECRET`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

## Template dependencies

- Cloudflare apps: `aloewright/aloe-template-cloudflare-fullstack`
- Swift apps: `aloewright/warp-template-apple-multiplatform`
