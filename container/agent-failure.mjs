/* AGPL-3.0-or-later */
// Classify a non-zero claude/codex agent exit into a specific, actionable error so the
// worker reaper can treat rate-limits (defer/surface), timeouts (retry, capped), and auth
// (surface) differently instead of lumping all into 'agent_error'.
const RATE = /you'?ve hit your (session|usage) limit|usage limit (reached|exceeded)|rate.?limit|resets?\s+\d/i;
const AUTH = /invalid bearer token|not logged in|please run \/login|401/i;

// Parse "resets 3:50am (UTC)" (no date) -> ISO timestamp; assume the next occurrence.
export function parseResetTime(text, nowMs = Date.now()) {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?utc\)?/i.exec(text || "");
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] ?? "0");
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  const now = new Date(nowMs);
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
  if (target.getTime() <= nowMs) target.setUTCDate(target.getUTCDate() + 1); // day rollover
  return target.toISOString();
}

export function classifyAgentFailure(code, stdout = "", stderr = "", nowMs = Date.now()) {
  const text = `${stdout}\n${stderr}`;
  // Order matters: SIGKILL/timeout first (a process killed by the AGENT_TIMEOUT_MS
  // watchdog or container teardown carries no useful stdout to classify), then AUTH,
  // then RATE so an auth message that happens to contain "401" isn't misread as a limit.
  if (code === 143 || code === 137) return { error: "agent_timeout", retryAfter: null };
  if (AUTH.test(text)) return { error: "claude_auth_failed", retryAfter: null };
  if (RATE.test(text)) return { error: "claude_rate_limited", retryAfter: parseResetTime(text, nowMs) };
  return { error: "agent_error", retryAfter: null };
}
