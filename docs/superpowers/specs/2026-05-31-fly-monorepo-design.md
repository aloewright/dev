# fly.pm Monorepo + Standardized Worker Stack — Design

**Date:** 2026-05-31
**Status:** Design (execution deferred until the live universal-login rollout is stable)
**Related:** `2026-05-31-flypm-universal-login-design.md`, `2026-05-31-auth-worker-integrations-design.md`

## 1. Goal

Consolidate the fly.pm app workers into **one monorepo** with a **single standardized stack**, so shared concerns (auth-hub glue, UI, DB helpers, config) live in one place and stop being hand-copied per repo. Each worker stays an independently-deployed Cloudflare Worker with its own bindings; the monorepo shares **code, not infrastructure**.

The trigger: the universal-login cutover required copying the same `getHubSession` / hub-login-redirect / hub-sign-out logic into cal, storage, and mail. That duplication is why a sign-out bug had to be fixed three times and why cal/storage diverged. A shared `@fly/auth-client` package removes that class of problem.

## 2. Standardized stack (every worker)

- **Edge/API/RPC: Hono.** Owns the fast paths — redirects, tracking, `/api/*`, webhooks, service-binding RPC. No React in the hot path.
- **UI: TanStack Start**, mounted in the *same* worker (Start mounts a Hono server handler). Workers that are UI-light (auth hub machine endpoints, apex redirect/track) keep those paths in Hono and use Start only for their actual screens.
- **Build: Vite 8** (Rolldown) via **`@cloudflare/vite-plugin`** for Workers deployment — **never** Nitro's Cloudflare preset (the Vite 8 breakage is on the Nitro path; `@cloudflare/vite-plugin@^1.39` lists `vite ^8.0.0`). React Compiler config uses the **Rolldown plugin preset**, not the babel `viteReact` preset.
- **Lint/format: oxlint + Prettier.** (oxfmt dropped — not stable enough yet.)
- **Client data: TanStack Query + Table + Virtual.**
- **Auth: better-auth**, consumed through the shared **`@fly/auth-client`** (the hub at auth.fly.pm remains the only user-writing instance).
- **DB: Drizzle + D1**, one D1 per worker (no shared database).
- **AI/agentic: Cloudflare Agents SDK** — per-worker, only where the function needs it (mail, dev; cal/apex if/when they add AI).
- **Package manager: pnpm** (workspaces). **No Turborepo** — pnpm's own `--filter '...[origin/main]'` gives affected-app deploys, and build caching comes from Cloudflare Workers Builds / wrangler + Vite 8 (Rolldown), so a separate task-runner/cache layer isn't warranted at this scale. (Add it later only if CI build time actually hurts — it's an additive drop-in.)
- **Mobile: Capacitor** per-app where the function ships native apps (apex already carries `android/` + `apple/`).

Reference implementation: **`short-links` (the apex worker) is already on this exact stack** — `vite@8` + `@tanstack/react-start@1.168` + `@cloudflare/vite-plugin@1.39` + Hono + TanStack Query/Table/Virtual + better-auth + Drizzle, pnpm workspace, deployed to fly.pm. So we are standardizing on a stack that is **proven in-fleet, not a bet** — short-links is the template every other app copies. (It still needs oxlint + Prettier added via `@fly/config`.)

## 3. Monorepo layout

```
fly/
  apps/
    apex/      → fly.pm         (SEED/reference = today's short-links; marketing [Start]; short-link redirect + open/click tracking [Hono, hot path]; Capacitor android/apple)
    auth/      → auth.fly.pm    (login hub: OIDC, /api/auth/*, token broker [Hono]; login/account [Start])
    mail/      → mail.fly.pm
    cal/       → cal.fly.pm     (REWRITE onto the standard stack — copies the apex/short-links template)
    storage/   → storage.fly.pm
    dev/       → dev.fly.pm
  packages/
    auth-client/   ← getHubSession (tri-state), hubLoginUrl(app), hub-sign-out, types — the de-duplicated hub glue
    ui/            ← shared React components, theme, the branded login/consent shells
    db/            ← Drizzle helpers, common column sets, migration conventions
    config/        ← base tsconfig, oxlint + prettier config, a base wrangler snippet, shared deps/pins
  pnpm-workspace.yaml
  .github/workflows/deploy.yml
```

`short-links` currently lives at `~/Documents/links/short-links` (github `aloewright/short-links`); it becomes `apps/apex` and seeds the canonical config.

**Out of scope:** `ts.fly.pm` (standalone vibesdk fork, bespoke auth — stays its own repo); `tasks` / daily-planner (Next.js/OpenNext — **not** migrated now; revisit later).

## 4. Shared packages — where consistency actually lives

- **`@fly/auth-client`** — the single implementation of the hub session protocol: tri-state `getHubSession` (mapped session / unprovisioned / none), `hubLoginUrl({app, redirect})`, hub sign-out (proxy + relay the `.fly.pm` clearing cookie), and the email→local-user mapping helper. Every app imports this; bugs are fixed once. This package is **extracted from the now-working cal/storage/mail pattern** once the live rollout is stable.
- **`@fly/ui`** — the branded login/consent/account shells + shared components, so `Sign in to <app>` looks identical everywhere.
- **`@fly/db`** — Drizzle conventions and the better-auth-compatible column sets (the camelCase/timestamp shapes the fleet already shares).
- **`@fly/config`** — base `tsconfig`, `oxlint`, `prettier`, and a base `wrangler` fragment + the canonical dependency pins (vite, react-start, cloudflare/vite-plugin, wrangler) so all workers move in lockstep.

## 5. Per-worker infrastructure (unchanged by the monorepo)

Each worker keeps its **own `wrangler.jsonc`**, **own D1/KV/R2/Vectorize/DO/Agents**, **own routes**, **own secrets** (Doppler). No shared database — identity maps **by email** (per the universal-login decision; D1 has no cross-DB joins and app data is keyed on local ids). The monorepo changes how code is organized and deployed, not the runtime topology.

## 6. Deployment — per-worker, from one repo

GitHub Actions with a path filter so only changed apps deploy:

- A workflow triggers on push to `main`.
- pnpm determines affected apps natively: `pnpm --filter '...[origin/main]' deploy` runs the `deploy` script only for workspaces touched by the diff (or `dorny/paths-filter` → matrix).
- Each app's `deploy` script runs `wrangler deploy` with its own config.
- A change to a shared package (`packages/*`) fans out to every dependent app's deploy — correct, and scoped by pnpm's workspace dependency graph. Keep shared packages small/stable.
- Secrets per worker via repository/environment secrets or `wrangler secret` synced from Doppler.
- **Build caching:** Cloudflare Workers Builds / wrangler caches dependencies + build output, and Vite 8 (Rolldown) builds are already fast — no separate build-cache layer needed.

Cloudflare **Workers Builds** (connect-the-repo, one build config per worker) is a viable alternative to Actions and makes a task-runner even less relevant; Actions chosen for path-filter control. Either keeps deploys **per worker**.

## 7. Vite 8 decision — confirmed (proven in-fleet)

Adopt **Vite 8** (Rolldown, 10–30× faster). This is no longer a bet: **`short-links`/apex already runs `vite@8.0.14` + `@tanstack/react-start@1.168` + `@cloudflare/vite-plugin@1.39` and deploys to fly.pm** — exactly the Workers path we standardize on. The Vite-8 breakage seen elsewhere is the **Nitro** server path, which we don't use. `@fly/config` pins the version (`vite@8`, `@cloudflare/vite-plugin@^1.39`, `@tanstack/react-start@^1.168`, `wrangler@^4.95`) fleet-wide; short-links is the reference config. React Compiler (if used) configures via the **Rolldown plugin preset**, not the babel `viteReact` preset.

## 8. Migration sequencing

1. **Finish the live universal-login rollout first** (current separate repos): storage `/api/objects` fix [done], mail deploy, cal sign-out [done], tasks gate. Nothing half-broken before a big move.
2. **Seed the monorepo from `short-links`/apex** (already standard-stack): it becomes `apps/apex` and the canonical config; lift its tsconfig/wrangler/vite setup into `@fly/config` (add oxlint + Prettier). Extract **`@fly/auth-client`** from the now-working hub pattern.
3. **Move the React/Hono apps** (auth, storage, dev) in, swapping their copied hub glue for `@fly/auth-client`.
4. **Rewrite cal** onto the standard stack by copying the apex/short-links template.
5. **Move mail** last (heaviest; DOs, Agents, Vectorize, Email).
6. Wire **per-worker GitHub Actions** (pnpm `--filter`) deploy.

Each step is independently shippable; the live fleet keeps running on the current per-repo deploys until each worker is cut over.

## 9. Risks & mitigations

- **Vite 8** → proven in-fleet via short-links/apex; adopt directly (no pilot/fallback needed).
- **Heterogeneous package managers today** (bun/pnpm/npm) → monorepo standardizes on pnpm; per-app lockfiles disappear.
- **Shared-package blast radius** (a `packages/*` change redeploys dependents) → correct behavior, scoped by pnpm's workspace dependency graph; keep shared packages small and stable.
- **cal + (later) tasks are rewrites, not moves** → cal is deliberate and scoped here (copies the apex template); tasks is explicitly deferred.
- **Secret drift (Doppler ↔ Worker secrets)** → `@fly/config` documents the canonical sync; per-worker secrets remain isolated.

## 10. Non-goals

- Migrating `ts.fly.pm` or `tasks`/daily-planner now.
- Sharing a database or unifying user ids (identity maps by email).
- Changing per-worker runtime topology or custom domains.
