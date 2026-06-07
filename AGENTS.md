## Learned User Preferences

- When asked to ship work, complete remaining items, open a PR, address review comments, fix CI, merge once checks pass, and close superseded PRs
- When integrating stale automated branches, cherry-pick net-new deltas onto `main` rather than wholesale merge
- Agent memory must be best-effort: recall failures return empty context; retain must never block or fail the run hot path
- Secrets live in Doppler (`quickapp` project); sync to Wrangler via secrets, not committed config
- Execute approved implementation plans quickly once design is signed off

## Learned Workspace Facts

- fly-dev is the Cloudflare-native orchestrator for the fly.pm app family at `dev.fly.pm`; GitHub repo is `aloewright/fly-dev`
- Worker entry is `worker/src/index.ts`; Vite frontend proxies `/api` to the Worker (`127.0.0.1:5173` → `8787` locally)
- Read `.claude/skills/fly-dev/SKILL.md` for repo conventions before making changes
- Core data plane: D1 (users, runs, projects, memories), Queues (`MEMORY_QUEUE`), Durable Objects, Workflows, R2, Containers for CLI sandboxes
- Linear is the project source of truth; GitHub repos are mapped with confidence scoring
- Agent memory uses self-hosted Hindsight at `https://hindsight.fly.pm` behind Cloudflare Access; bank keys are `u:{userId}:p:{projectId}`
- Hindsight infra lives in `infra/hindsight/` (GCE VM + cloudflared); monitor Worker at `infra/hindsight-monitor/`
- `MEMORY_ENABLED=true` in `wrangler.jsonc`; client at `worker/src/platform/memory/hindsight.ts`
- Cursor Hindsight hooks use bank `cursor-p-fly-dev`; seed with `doppler run -- node .cursor/hooks/seed-hindsight.mjs`
- Verification before merge: `npm run typecheck`, `npm test`, `npm run build`, `npm run cf:dry-run`
- Worker and container source files use `AGPL-3.0-or-later` license headers
