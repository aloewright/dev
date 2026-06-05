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
});
