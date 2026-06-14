# Universal fly.pm Login — Design (Wave 0 + Wave 1)

**Date:** 2026-05-31
**Status:** Approved (architecture + scope), ready for implementation planning
**Scope of THIS spec:** Wave 0 (the `auth.fly.pm` hub) and Wave 1 (cut dev.fly.pm over to it and remove Cloudflare Access). Waves 2–3 (folding in cal/mail/links, then tasks/storage/pub) are sketched at the end and will get their own specs.

---

## 1. Goal

Replace Cloudflare Access on dev.fly.pm with a **universal fly.pm login**: one central auth hub at `auth.fly.pm` owns all login, backed by a single dedicated user database. A session cookie scoped to `.fly.pm` works across every fly.pm subdomain (SSO). For dev.fly.pm specifically: **only logged-in `@fly.pm` users may access the application.**

This replaces the current state where dev.fly.pm is gated by Cloudflare Access (Zero Trust, 8-email allowlist) and the broader fly.pm fleet has three separate better-auth user databases and inconsistent cookie config.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Canonical user store | **New dedicated D1 `fly-auth`** (auth data isolated from app data) |
| Auth model | **Centralized hub** — one `auth.fly.pm` worker is the only better-auth instance that writes users; other apps proxy |
| Login UI | **Central branded page** at `auth.fly.pm/login`; apps redirect there with `?redirect=<return-url>` |
| Session validation | **Proxy every protected request** to the hub's `/api/auth/get-session` (forwarding the `.fly.pm` cookie) |
| Who may log in | **`@fly.pm` emails only** (mirrors mail.fly.pm's existing signup gate) |
| dev.fly.pm authorization | **Any authenticated `@fly.pm` user** (NOT the old 8-email allowlist) |
| Rollout | **Phased**; this spec = Wave 0 + Wave 1 |
| Cloudflare Access on dev.fly.pm | **Removed** in Wave 1 (atomic with the app-level gate going live) |

**Shared invariants every fly.pm app must agree on** (set now, depended on by all later waves):
- Cookie `Domain=.fly.pm` (leading dot), default better-auth cookie prefix (`better-auth.session_token`), `Secure`, `SameSite=Lax`.
- **`BETTER_AUTH_SECRET` is held by the hub only.** Consumer apps validate by proxying to the hub's `get-session` and therefore do **not** receive the secret — this keeps the trust anchor in one place and limits blast radius. If a later wave needs local (non-proxied) validation, do **not** distribute the symmetric secret; switch to asymmetric keys (RS256/EdDSA) where only the hub holds the private key and apps verify with a public key. See §7 (Security considerations) for rotation policy and scoping.

**Cookie ownership (important):** the **hub is the only component that mints or sets auth cookies.** Consumer apps (dev.fly.pm and all later waves) NEVER call `setCookie`/run better-auth's cookie-setting paths — they only **read** the incoming `.fly.pm` cookie and **forward** it to the hub's `get-session`. This avoids two apps fighting over the same cookie and keeps the secret as the single trust anchor. (Consumer apps therefore do not need `crossSubDomainCookies` config; only the hub does.)

## 3. Architecture

```
                    ┌─────────────────────────────────────┐
                    │  auth.fly.pm  (NEW hub worker)       │
                    │  • better-auth (ONLY user writer)    │
                    │  • /login  (branded central page)    │
                    │  • /api/auth/*  (sign-in/out, OAuth) │
                    │  • /api/auth/get-session  (validate) │
                    │  • @fly.pm email signup gate         │
                    │  • mints cookie Domain=.fly.pm       │
                    └───────────────┬─────────────────────┘
                                    │ owns (only writer)
                    ┌───────────────▼─────────────────────┐
                    │  fly-auth  (NEW dedicated D1)        │
                    │  user / account / session / verif.  │
                    └─────────────────────────────────────┘
        proxy get-session (forward .fly.pm cookie) ▲
   ┌──────────────────────────────────────────────┴──────────────┐
 dev.fly.pm (Wave 1)            …cal/mail/tasks/storage/pub (Waves 2–3)
 read cookie → call hub get-session → user|null
   → if null & HTML: 302 → auth.fly.pm/login?redirect=<url>
   → if user & @fly.pm: render ; else 403
```

## 4. Components

### 4.1 Wave 0 — `auth.fly.pm` hub (new project `~/Development/fly-auth`)

A new Cloudflare Worker, the only better-auth instance that writes users.

- **DB:** new D1 `fly-auth` (id assigned at creation), better-auth-cloudflare adapter (Drizzle, `usePlural`), matching mail.fly.pm's proven setup. Tables: `users`, `sessions`, `accounts`, `verifications`.
- **better-auth config:**
  - `emailAndPassword: { enabled: true, requireEmailVerification: true }`. **`autoSignIn` is NOT enabled** for public sign-up — the `@fly.pm` suffix check alone is not proof of mailbox ownership, so a session is only minted after email verification (or via a verified IdP). See §7 (Security considerations) for the account-pre-takeover rationale.
  - `@fly.pm`-only gate: a `hooks.before` matcher on sign-up/sign-in-email that rejects non-`@fly.pm` emails (ported from `fly-mail/apps/web/src/server/auth.ts` L110–135).
  - `advanced.crossSubDomainCookies: { enabled: true, domain: ".fly.pm" }`, `useSecureCookies: true`, default cookie prefix.
  - `baseURL: https://auth.fly.pm`, `secret: BETTER_AUTH_SECRET`.
  - `trustedOrigins`: every fly.pm app origin (dev, cal, mail, tasks, storage, share, docs, links, pub, crm) + `auth.fly.pm`.
  - Optional: Google social provider (link-only), magic-link — port later; Wave 0 ships email+password.
- **Routes:**
  - `GET /login` — branded central login page (dark theme matching the app palette `#1A1B1E` / `#C1C2C5`, sailboat logo already hosted at `https://cal.fly.pm/brand/logo.svg`). Reads `?redirect=` (validated against the `*.fly.pm` host allowlist via `new URL()` parsing — see §7 — to prevent open-redirect), posts to `/api/auth/sign-in/email`, on success 302s to the redirect target.
  - `ALL /api/auth/*` — better-auth handler (sign-in, sign-out, get-session, etc.).
  - `GET /api/auth/get-session` — better-auth's session endpoint, used by every other app to validate. Returns `{ user, session } | null`.
  - `GET /health` — unauthenticated liveness.
- **Custom domain:** route `auth.fly.pm` (custom_domain) on the `fly.pm` zone.
- **Secrets:** `BETTER_AUTH_SECRET` (the shared fleet secret), Google creds if/when social added.
- **Seed:** ensure an `aloe@fly.pm` account exists (the user signs up via the page, or we seed it).

### 4.2 Wave 1 — `flyAuth` client helper + dev.fly.pm gate

A small reusable module added to fly-dev (and re-used in later waves).

- **`flyAuth.getUser(request, env)`:** read **only** the `better-auth.session_token` cookie from the incoming request; if absent → null. Else `fetch(${AUTH_HUB_URL}/api/auth/get-session, { headers: { cookie: "better-auth.session_token=" + sessionToken } })`. **Forward only that one cookie — never the whole incoming `Cookie` header**, which would leak CSRF tokens, app-specific state, and analytics cookies to the hub. Parse `{ user }`; return the user or null. **Fail closed:** any fetch error / non-200 → treat as null (unauthenticated), never as authenticated.
- **`flyAuth.requireUser(request, env)`:** call `getUser`; if a user with an `@fly.pm` email → return it; if a user without `@fly.pm` → `403`; if null:
  - HTML request (`Accept: text/html`) → `302 → ${AUTH_HUB_URL}/login?redirect=<encodeURIComponent(absolute current url)>`. The current URL must be **URL-encoded** (`encodeURIComponent`) so that its own query string (e.g. `/dashboard?tab=settings&project=1`) is carried intact rather than parsed as the hub's own params.
  - API request → `401 { error: "Authentication required" }`.
- **Integration into fly-dev:** replace the Cloudflare-Access branch in `worker/src/platform/auth-session.ts` `getCurrentUser`. New precedence: **flyAuth (hub session) → existing HMAC `x-fly-*` internal proxy (kept for machine calls) → local-dev**. The CF Access verification (`cf-access.ts`, `getCfAccessIdentity`) is removed.
- **Vars:** `AUTH_HUB_URL=https://auth.fly.pm` (non-secret var). Remove `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `LOGIN_ALLOWED_EMAILS`.

## 5. Data flow

**First login (cold):**
```
GET dev.fly.pm/  → flyAuth.getUser → no cookie → null
  → requireUser → 302 https://auth.fly.pm/login?redirect=https://dev.fly.pm/
  → user signs in (@fly.pm) → hub better-auth sets Set-Cookie: better-auth.session_token=…; Domain=.fly.pm; Secure; SameSite=Lax
  → 302 back to https://dev.fly.pm/
  → flyAuth.getUser → cookie present → hub get-session → { user: aloe@fly.pm }
  → @fly.pm ✓ → render dashboard
```
**SSO (warm) to another app:**
```
GET cal.fly.pm/  → cookie already present (.fly.pm) → hub get-session → user → render. No re-login. ✅
```
**Non-@fly.pm user:** hub get-session returns the user, app sees non-`@fly.pm` → `403`.
**Hub down:** getUser fails closed → null → redirect to login (which is also down, but dev.fly.pm stays **gated**, never open).

## 6. Cutover (Wave 1, atomic)

The risk is that removing Cloudflare Access un-gates dev.fly.pm at the edge; the app-level gate must be live first.

1. Deploy fly-dev with the `flyAuth` gate active (hub must already be live from Wave 0). At this point dev.fly.pm is gated by BOTH CF Access (edge) and flyAuth (app) — double-gated, safe.
2. Verify: logged-out → redirect to auth.fly.pm/login; logged-in `@fly.pm` → 200; non-`@fly.pm` → 403.
3. **Then** delete the Cloudflare Access apps for dev.fly.pm (the main app + the `/api/webhooks`, `/api/internal` bypass apps) via the CF API.
4. Verify again post-Access-removal; confirm `/api/webhooks/*` and `/api/internal/*` still work (they were Access-bypassed; now they rely on their existing HMAC/signature auth, which is unchanged).
5. Remove `cf-access.ts` + CF_ACCESS vars in the same or an immediately-following deploy.

Rollback: if the app gate misbehaves, re-enable the CF Access app (recreate via API from the documented config) before removing the cf-access code.

## 7. Security considerations

These are design-level requirements, not optional hardening — each must be satisfied by the Wave 0/1 implementation.

1. **Proof of email ownership before sign-in.** The hub exposes Better Auth sign-up, and the `@fly.pm` suffix check is *not* proof that the visitor controls that mailbox. With `autoSignIn`, anyone could register an arbitrary `@fly.pm` address (e.g. a colleague's) and immediately hold a valid `.fly.pm` session — pre-taking over an account before its real owner ever signs up. Mitigation: ship Wave 0 with `requireEmailVerification: true` and `autoSignIn` **off** for public sign-up, so a session is only minted after a verification link/OTP is confirmed (or via a verified IdP). Alternatively, disable public sign-up entirely and seed/invite accounts. This preserves the mailbox-verification guarantee that Cloudflare Access provided today.

2. **Secret blast radius & rotation.** A single symmetric `BETTER_AUTH_SECRET` is a fleet-wide trust anchor: anyone holding it can forge `.fly.pm` session tokens for every app. Mitigations:
   - **Least-privilege scoping** — the secret lives **only** in the hub worker. Consumer apps validate by proxying to `get-session` and never receive it, so a compromise of any consumer app cannot leak it.
   - **Rotation policy** — store it in Doppler/CF Secrets (never in code or vars), rotate on a fixed cadence and immediately on any suspected exposure or operator offboarding. Because better-auth signs sessions with the secret, rotating invalidates outstanding sessions (acceptable: users re-login); schedule rotations off-peak.
   - **Per-app considerations** — if a future wave genuinely needs local (non-proxied) validation, do **not** copy the symmetric secret to that app. Move to asymmetric keys (RS256/EdDSA): the hub holds the private signing key, apps verify with a public key, and a per-app compromise cannot mint tokens.

3. **Forward only the session cookie to the hub.** `flyAuth.getUser` must extract the single `better-auth.session_token` cookie and send *only* that in the sub-request to the hub. Forwarding the entire incoming `Cookie` header would leak CSRF tokens, other apps' session state, and analytics cookies into the hub's request logs and trust boundary.

4. **URL-encode the `redirect` parameter.** When an app 302s to `${AUTH_HUB_URL}/login?redirect=…`, the absolute return URL must be passed through `encodeURIComponent`. Appending it raw lets the return URL's own query string (`?tab=settings&project=1`) be parsed as the hub's params, dropping them after login.

5. **Validate `redirect` against a host allowlist (open-redirect).** Naive checks are bypassable — `endsWith('.fly.pm')` matches `https://evil-fly.pm` and a raw-string `includes('.fly.pm')` matches `https://attacker.com/?x=.fly.pm`. The hub must parse the value with `new URL()` and accept it only when `url.hostname === 'fly.pm'` or `url.hostname.endsWith('.fly.pm')` (a host-boundary check on the parsed hostname, plus an `https:` protocol check). On any parse error or mismatch, ignore the param and fall back to the app root. The accepted hosts are exactly the `trustedOrigins` fly.pm set, so the allowlist is the live source of truth, not a duplicated regex.

## 8. Error handling

| Condition | Behavior |
|---|---|
| No cookie | Unauthenticated → redirect (HTML) / 401 (API) |
| Cookie invalid/expired | Hub get-session returns null → redirect / 401 |
| Hub unreachable / 5xx | **Fail closed** → treat as unauthenticated → redirect / 401 (never grant access) |
| Authenticated, non-@fly.pm | 403 "not authorized for fly.pm" |
| `redirect` param not a `*.fly.pm` origin | Parse with `new URL()` and require the **hostname** to be exactly `fly.pm` or to end with `.fly.pm` (host-boundary check, not a substring/`endsWith` on the raw string). On any parse failure or mismatch, ignore it and redirect to a safe default (the app root) — prevents open-redirect bypasses. See §7. |

## 9. Testing

- **Hub in isolation:** sign-up `@fly.pm` succeeds; sign-up non-`@fly.pm` rejected; sign-in/out; `get-session` returns user with cookie, null without; `/health` 200.
- **dev.fly.pm gate:** logged-out HTML → 302 to hub login; logged-out API → 401; logged-in `@fly.pm` → 200; logged-in non-`@fly.pm` → 403; hub down → fails closed (redirect, not open).
- **SSO:** log in at hub → hit dev.fly.pm and cal.fly.pm without re-login (Wave 1 verifies dev.fly.pm; cal in Wave 2).
- **Machine paths:** `/api/webhooks/github` and `/api/internal/status` still authenticate via HMAC after Access removal.
- **Cookie attributes:** Set-Cookie has `Domain=.fly.pm; Secure; SameSite=Lax`, default prefix.
- **Security (§7):** unverified sign-up does not mint a session (no `autoSignIn`); only `better-auth.session_token` is forwarded to the hub (no other cookies leak); `redirect` with its own query string survives round-trip (URL-encoded); open-redirect attempts (`https://evil-fly.pm`, `https://attacker.com/?x=.fly.pm`) are rejected and fall back to the app root.

## 10. Out of scope (this spec)

- **Wave 2** — align cal.fly.pm + mail.fly.pm to the hub (mostly config: shared secret, redirect-to-hub login, drop local forms); migrate links.fly.pm (separate `fly` DB + `fly.*` cookie prefix → merge into fly-auth, biggest single migration). Own spec.
- **Wave 3** — wire tasks.fly.pm, storage, pub with the `flyAuth` helper. Own spec.
- **Out entirely:** ts.fly.pm (standalone per project decision), open-network/crm.fly.pm (no user auth; token-gated).
- User migration from the existing `fly-mail`/`fly`/`fly-dev` stores into `fly-auth` — addressed when each app joins (Waves 1–3); for Wave 0/1 the only required account is `aloe@fly.pm` in `fly-auth`.

## 11. Open follow-ups (not blocking Wave 0/1)

- Resolve the apex `fly.pm` vs `mail.fly.pm` "second hub" references in storage/fly-dev/daily-planner during Waves 2–3 (point them all at `auth.fly.pm`).
- Bump better-auth to a single aligned version (target 1.6.11) across apps as each joins.
- Decide whether mail.fly.pm keeps its own login form (it's the email app) or also redirects to the hub — Wave 2.
