/* AGPL-3.0-or-later */

// Self-healing policy predicates for the cron reaper. Kept pure (no env/DB) so the
// decisions that govern auto-retry are unit-testable in isolation; the DB
// orchestration that acts on them lives in worker/src/index.ts.

// Errors worth auto-retrying (infra/auth/transient). Deliberately NOT `no_changes`
// (the agent legitimately produced nothing) or `no_repository` (a config problem a
// retry can't fix). `no_changes` recovery is handled separately and one-time-only —
// see shouldRetryNoChanges.
export const RETRYABLE_ERRORS = [
  "clone_failed",
  "push_failed",
  "pr_failed",
  "commit_failed",
  "no_github_token",
  "agent_error",
  "Container /run returned",
  "exception",
  "Agent produced no changes",
];

export const MAX_RUN_RETRIES = 3;

export function isRetryableError(lastError: string | null): boolean {
  if (!lastError) return false;
  return RETRYABLE_ERRORS.some((needle) => lastError.includes(needle));
}

// `no_changes` is normally terminal — a clean signal that the issue had no work. But a
// batch produced empty output during a dead-OAuth-token window: the emptiness was the
// dead token, not the work being done. We give each `no_changes` run EXACTLY ONE
// recovery retry, marked in metadata so a genuine no-op never loops every cron tick.
export function shouldRetryNoChanges(meta: Record<string, unknown>): boolean {
  return meta.noChangesRetried !== true;
}

// A run flips back to 'queued' for two unrelated reasons that must NOT share a budget:
//  - ERROR retry: a retryable failure (clone_failed, agent_error, …). Tight cap.
//  - STUCK re-dispatch: the run is queued/running but the reaper picked it up — almost
//    always because it is waiting for one of the few container slots (or a queue message
//    was lost). This is NOT a failure; a backlog draining through limited slots must not
//    burn the error budget and falsely fail runs that did nothing wrong. Generous cap.
export const MAX_STUCK_REDISPATCH = 20;

export function reapKind(status: string): "stuck" | "error" {
  return status === "running" || status === "queued" ? "stuck" : "error";
}

export function reapBudgetField(kind: "stuck" | "error"): "stuckRedispatch" | "retryCount" {
  return kind === "stuck" ? "stuckRedispatch" : "retryCount";
}

export function reapBudgetCap(kind: "stuck" | "error"): number {
  return kind === "stuck" ? MAX_STUCK_REDISPATCH : MAX_RUN_RETRIES;
}
