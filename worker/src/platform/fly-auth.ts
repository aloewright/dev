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
export async function getFlyAuthUser(request: Request, env: Env): Promise<FlyAuthUser | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie || !cookie.includes("better-auth.session_token")) {
    // No session cookie at all — skip the hub round-trip.
    return null;
  }

  let session: { user?: { id?: string; email?: string | null; name?: string | null } } | null;
  try {
    const res = await fetch(`${hubUrl(env)}/api/auth/get-session`, {
      headers: { cookie, accept: "application/json" },
      // Never let a slow/dead hub hang the request; fail closed on error.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return null;
    }
    session = (await res.json()) as typeof session;
  } catch {
    // Hub unreachable / timeout / bad JSON → unauthenticated (fail closed).
    return null;
  }

  const user = session?.user;
  if (!user?.id || !isFlyPmEmail(user.email)) {
    return null;
  }
  return { id: user.id, email: user.email, name: user.name ?? null };
}

// Build the hub login URL that returns the user to where they were headed.
export function hubLoginRedirect(request: Request, env: Env): string {
  const here = new URL(request.url);
  const target = `${here.origin}${here.pathname}${here.search}`;
  const login = new URL("/login", hubUrl(env));
  login.searchParams.set("redirect", target);
  return login.toString();
}
