# Auth worker owns all integrations — Design (Wave 2 re-architecture)

**Date:** 2026-05-31
**Status:** Approved (direction + key decisions); build the additive foundation, gate the live-token migration behind a verified cutover.
**Supersedes** the earlier "Wave 2 = per-app proxy + email mapping" plan with a cleaner end-state: the auth worker (`auth.fly.pm`) is the fleet's single identity + integration broker.

## 1. Goal & why

`auth.fly.pm` already owns **login** (Waves 0/1/1.5). Wave 2 makes it also own **all third-party integrations** (Google/Gmail OAuth, future providers). Apps (mail, cal, tasks, docs) stop running their own better-auth and stop holding provider refresh tokens; they:
1. **Proxy login** to the hub (validate the `.fly.pm` cookie via `/api/auth/get-session`) — same pattern as dev.fly.pm.
2. Map the hub user → their **pre-existing local data row by email** (no data migration; their app data stays keyed on the local `users.id` it already uses).
3. When they need to call a provider API (Gmail/Calendar/Contacts), ask the hub for a **short-lived provider access token** via a **Cloudflare service binding** — the hub holds + refreshes the refresh token; apps never see it.

This dissolves the "Gmail link needs a mail-local session" bridge problem: linking happens **on the hub**, where the session already lives. One Google OAuth app, one secret, one `accounts` table.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Integration ownership | **Auth worker owns ALL OAuth** (Google now; others later). Single `accounts` table on the `fly-auth` D1. |
| App→hub provider tokens | **Cloudflare service binding** (worker-to-worker, same account; no public endpoint/HMAC). |
| Identity mapping | **Map by email** to each app's existing local `users` row. **No data re-keying / no migration.** (D1 has no cross-DB joins, and app data is keyed on local ids — re-keying would orphan live data.) |
| Repo structure | **Stay separate repos for now.** Monorepo consolidation is deferred (large, orthogonal, fixes nothing on its own). A shared `auth-client` config is published/copied so configs don't drift. |
| Scope this wave | **cal + links + tasks** can fold immediately (login proxy only). **mail** folds in two safe steps: (1) login→hub, (2) move Google token ownership to the hub behind a verified cutover. |

## 3. The live data that must NOT break

`fly-mail` D1 (`a61c11ce`) holds **7 Google `accounts` rows with refresh tokens**, all owned by `aloe@fly.pm` (scopes: gmail.modify, calendar, contacts, userinfo). Mail's messages/threads/labels and these tokens all cascade off mail's local `users.id`. **Any change must keep that id and these tokens intact.** The `fly-auth` `accounts` table currently has no Google rows.

## 4. Architecture

```
                    ┌────────────────────────────────────────────┐
                    │  auth.fly.pm (hub)                          │
                    │  • better-auth: login + ALL OAuth providers │
                    │  • /account: link Google, manage passkeys   │
                    │  • accounts table = refresh tokens (1 place)│
                    │  • Service-binding RPC: getProviderToken(   │
                    │      userId|email, provider) -> {accessToken,│
                    │      expiresAt, scopes}  (refreshes as needed)│
                    └───────────────┬─────────────────────────────┘
            cookie get-session ▲    │ service binding (AUTH RPC)
                               │    ▼
   ┌───────────────────────────┴───────────────────────────────┐
 mail.fly.pm        cal.fly.pm        tasks.fly.pm        docs/links…
 - login: proxy hub cookie -> get-session -> map local user by email
 - Gmail import: call AUTH.getProviderToken() for a short-lived access token
   (NO local refresh tokens, NO local /api/auth/* for primary login)
```

## 5. Components

### 5.1 Hub: provider-token broker (NEW, additive — safe to build first)
- A service-binding RPC method on the hub worker (WorkerEntrypoint): `getProviderToken({ email, provider, requiredScopes? })` → looks up the user's `accounts` row for that provider, refreshes the Google access token using the stored refresh token if expired, returns `{ accessToken, expiresAt, scopes }`. Never returns the refresh token. Returns a typed "not linked / missing scope" result so apps can prompt a re-link.
- Exposed via `export class AuthService extends WorkerEntrypoint`. Apps add a `services` binding `{ binding: "AUTH", service: "fly-auth", entrypoint: "AuthService" }`.
- **Additive:** doesn't touch login or existing tokens; can be built + tested in isolation.

### 5.2 Hub: own the Google provider (config already present)
- The hub's better-auth already has the Google `socialProvider` wired (from the Wave 0 port) — it just needs the Gmail/Calendar/Contacts scopes + `accessType: offline` + `prompt: consent` (copy mail's scope list) and account-linking enabled (`allowDifferentEmails`, `trustedProviders:['google']`). `/account` gets a "Connect Google" button (link-social) so you can link Gmail **on the hub**.

### 5.3 Apps: login proxy + email mapping (per app)
- Copy fly-dev's `fly-auth.ts` (`getFlyAuthUser` + `hubLoginRedirect`).
- Replace the app's session check with the hub proxy; resolve to the **existing local `users` row by email** (email is unique in each app's users table — deterministic). Page navigations of unauthenticated users → `302` to `auth.fly.pm/login`.
- cal: map to **mail's `AUTH_DB.users.id`** (its events are keyed there). links/mail: map to their own local `users.id`. tasks: keys by email already.
- Retire each app's local primary-login surface (sign-in form, `/api/auth/*` primary mount). Sign-out → hub `/logout`.

### 5.4 Mail: the two-step cutover (HIGH RISK — gated)
- **Step A (safe):** mail switches *primary login* to the hub proxy (like the others), mapping to its existing `users.id` by email. Gmail import KEEPS using mail's local `accounts` tokens for now (unchanged). Verify inbox + import still work.
- **Step B (the migration, gated):** move Google token ownership to the hub. Re-link Google **on the hub** (`auth.fly.pm/account` → Connect Google) so the hub gets its own fresh refresh token(s) with the same scopes. Switch mail's import code to call `AUTH.getProviderToken()` instead of reading local `accounts`. Only after verifying the hub-brokered token successfully calls the Gmail API do we stop using mail's local tokens. **The old mail tokens are left in place (not deleted) until the hub path is proven** — instant rollback.

## 6. Migration order (each verified before next)
1. **Hub:** add provider-token broker RPC + Google scopes + `/account` Connect-Google. (Additive; nothing else changes.)
2. **cal**, **links**, **tasks**: login proxy + email mapping. (Lower risk; each its own PR + verify.)
3. **mail Step A:** login→hub (import still local). Verify email works.
4. **mail Step B:** re-link Google on hub → switch import to broker → verify Gmail API call → then retire local tokens. (Gated, reversible.)

## 7. Error handling / safety
- Login proxy **fails closed** (hub down → unauthenticated → redirect; never open).
- Broker: provider not linked / scope missing → typed error → app prompts re-link (never crashes the feature).
- **No token is deleted until its hub-brokered replacement is proven** (Step B). Old mail `accounts` rows remain as rollback.
- Map-by-email must resolve to the **existing** local `users.id` (verify the row exists before cutover) — never mint a new id for a user whose data already exists.

## 8. Out of scope (this spec)
- Monorepo consolidation (separate effort).
- Magic link on the hub (still pending email-send wiring).
- Non-Google providers (future, same broker shape).
- ts.fly.pm (standalone), open-network/crm (no user auth).

## 9. What gets built NOW vs gated
- **NOW (additive, safe):** hub provider-token broker RPC + Google scopes/linking + `/account` Connect-Google; cal/links/tasks login proxy.
- **GATED (needs your go + live verification at each step):** mail Step A, then mail Step B (the only part touching live Gmail tokens).
