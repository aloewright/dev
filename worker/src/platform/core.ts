/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { first, runSql } from "./data";
import { redactSecrets } from "./crypto";

export type Core = { soul: string; rules: string };

// The user's global soul (identity/values/guardrails) + rules (always-follow
// instructions). Injected into goal decomposition and every run prompt.
export async function getCore(env: Env, userId: string): Promise<Core> {
  const row = await first<{ soul: string; rules: string }>(
    env,
    "SELECT soul, rules FROM core_config WHERE user_id = ?",
    [userId],
  );
  return { soul: row?.soul ?? "", rules: row?.rules ?? "" };
}

// A prompt preamble built from the core, or "" when nothing is configured.
export function buildCorePreamble(core: Core): string {
  const parts: string[] = [];
  if (core.soul.trim()) parts.push(`# Soul — identity, values, and guardrails (always honor)\n${core.soul.trim()}`);
  if (core.rules.trim()) parts.push(`# Rules (always follow)\n${core.rules.trim()}`);
  return parts.join("\n\n");
}

export async function getCoreResponse(env: Env, user: CurrentUser): Promise<Response> {
  return Response.json(await getCore(env, user.id));
}

export async function saveCore(env: Env, user: CurrentUser, payload: { soul?: unknown; rules?: unknown }): Promise<Response> {
  // Soul/rules are operator-authored prompt text, not secrets — but redact any
  // token-shaped strings defensively before they're stored and replayed into prompts.
  const soul = redactSecrets(typeof payload.soul === "string" ? payload.soul : "").slice(0, 20_000);
  const rules = redactSecrets(typeof payload.rules === "string" ? payload.rules : "").slice(0, 20_000);
  await runSql(
    env,
    `INSERT INTO core_config (user_id, soul, rules, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET soul = excluded.soul, rules = excluded.rules, updated_at = CURRENT_TIMESTAMP`,
    [user.id, soul, rules],
  );
  return Response.json({ soul, rules });
}
