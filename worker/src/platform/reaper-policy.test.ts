/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { isRetryableError } from "./reaper-policy";

describe("isRetryableError", () => {
  it("retries agent_timeout (bounded by the error budget)", () => {
    expect(isRetryableError("agent_timeout")).toBe(true);
  });
  it("does NOT retry claude_rate_limited (surface, don't re-hit the limit)", () => {
    expect(isRetryableError("claude_rate_limited")).toBe(false);
  });
  it("still retries the existing infra/auth errors", () => {
    expect(isRetryableError("agent_error")).toBe(true);
    expect(isRetryableError("clone_failed")).toBe(true);
  });
  it("does not retry terminal errors or null", () => {
    expect(isRetryableError("no_changes")).toBe(false);
    expect(isRetryableError("claude_auth_failed")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
  it("does NOT retry a classified permanent clone auth/permission failure", () => {
    // A 401/403/'not granted'/'Permission denied' clone can't be fixed by retrying the
    // same unreachable token; re-dispatching it ~20x was the dominant failure-storm.
    expect(isRetryableError("clone_auth_failed")).toBe(false);
  });
  it("does NOT retry a classified transient clone failure (recovered in-container, not via the cron storm)", () => {
    expect(isRetryableError("clone_transient_failed")).toBe(false);
  });
  it("substring matcher: the classified clone codes do not collide with retryable 'clone_failed'", () => {
    // Guards the .includes() matcher: '…_auth_failed' / '…_transient_failed' must not
    // contain the substring 'clone_failed', or they'd wrongly inherit its retryability.
    expect("clone_auth_failed".includes("clone_failed")).toBe(false);
    expect("clone_transient_failed".includes("clone_failed")).toBe(false);
  });
});
