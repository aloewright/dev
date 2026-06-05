/* AGPL-3.0-or-later */
// fly.pm universal-login client. dev.fly.pm does NOT mint cookies or run its own
// login — it forwards the incoming `.fly.pm` session cookie to the central hub
// (auth.fly.pm) and trusts the hub's answer. This is the consumer side of the
// architecture in fly-dev/docs/superpowers/specs/2026-05-31-flypm-universal-login-design.md.
//
// Fail CLOSED: any error, non-200, or missing/!@fly.pm user is treated as
// unauthenticated. dev.fly.pm must never fall open if the hub is unreachable.
import type { Env } from "../env";

const ALLOWED_EMAIL_DOMAIN = "fly.pm";

export type FlyAuthUser = {
  id: string;
  email: string;
  name: string | null;
};

function isFlyPmEmail(email: string | null | undefined): email is string {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

function hubUrl(env: Env): string {
  return env.AUTH_HUB_URL || "https://auth.fly.pm";
}

// Validate the request's session against the hub. Returns the @fly.pm user, or
// null when unauthenticated / not a @fly.pm account / hub unreachable.
// Per-isolate cache of validated hub sessions, keyed by the session token. WHY:
// dev.fly.pm validates by calling the hub's get-session on EVERY request and fails
// CLOSED on any non-200/timeout. A burst (e.g. deleting several repos fires many
// delete + dashboard-refetch requests) otherwise hammers the hub in parallel; a
// single throttle/blip among them returns null and logs the user out mid-session
// (the "kicked out / can't stay logged in" loop). Caching absorbs the burst (≤1 hub
// call per FRESH window) and a GRACE window rides out a transient hub failure using
// the last-good result instead of bouncing the user to login.
const SESSION_FRESH_MS = 30_000; // reuse without a hub round-trip
const SESSION_GRACE_MS = 120_000; // on hub failure, fall back to the last-good result
const MAX_SESSION_CACHE = 500; // bound memory (single-tenant today, but stay safe)
const sessionCache = new Map<string, { user: FlyAuthUser; at: number }>();

function sessionKey(cookie: string): string {
  const m = /better-auth\.session_token=([^;]+)/.exec(cookie);
  return m?.[1] ?? cookie;
}

export async function getFlyAuthUser(request: Request, env: Env): Promise<FlyAuthUser | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie || !cookie.includes("better-auth.session_token")) {
    // No session cookie at all — skip the hub round-trip.
    return null;
  }

  const key = sessionKey(cookie);
  const now = Date.now();
  const cached = sessionCache.get(key);
  if (cached && now - cached.at < SESSION_FRESH_MS) {
    return cached.user; // fresh — absorb bursts without re-validating against the hub
  }

  let session: { user?: { id?: string; email?: string | null; name?: string | null } } | null;
  try {
    const res = await fetch(`${hubUrl(env)}/api/auth/get-session`, {
      headers: { cookie, accept: "application/json" },
      // Never let a slow/dead hub hang the request.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`hub get-session ${res.status}`);
    }
    session = (await res.json()) as typeof session;
  } catch {
    // Transient hub failure (throttle/timeout/blip): ride out on the last-good result
    // within the grace window rather than logging the user out. Otherwise fail closed.
    if (cached && now - cached.at < SESSION_GRACE_MS) {
      return cached.user;
    }
    return null;
  }

  const user = session?.user;
  if (!user?.id || !isFlyPmEmail(user.email)) {
    // The hub explicitly says this cookie has no valid @fly.pm session — drop any stale
    // positive so a real sign-out takes effect.
    sessionCache.delete(key);
    return null;
  }

  const result: FlyAuthUser = { id: user.id, email: user.email, name: user.name ?? null };
  if (sessionCache.size >= MAX_SESSION_CACHE) sessionCache.clear();
  sessionCache.set(key, { user: result, at: now });
  return result;
}

// Build the hub login URL that returns the user to where they were headed.
export function hubLoginRedirect(request: Request, env: Env): string {
  const here = new URL(request.url);
  const target = `${here.origin}${here.pathname}${here.search}`;
  const login = new URL("/login", hubUrl(env));
  login.searchParams.set("redirect", target);
  return login.toString();
}
