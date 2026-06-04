/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import {
  isRetryableError,
  shouldRetryNoChanges,
  MAX_RUN_RETRIES,
} from "../worker/src/platform/reaper-policy";

describe("isRetryableError", () => {
  it("retries transient infra/auth errors", () => {
    expect(isRetryableError("clone_failed")).toBe(true);
    expect(isRetryableError("push_failed: 403")).toBe(true);
    expect(isRetryableError("Container /run returned 500")).toBe(true);
  });

  it("does not retry terminal errors", () => {
    expect(isRetryableError("no_changes")).toBe(false);
    expect(isRetryableError("no_repository")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe("shouldRetryNoChanges", () => {
  it("retries a fresh no_changes run exactly once", () => {
    expect(shouldRetryNoChanges({})).toBe(true);
    expect(shouldRetryNoChanges({ retryCount: 2 })).toBe(true);
  });

  it("never retries a no_changes run that was already recovered", () => {
    expect(shouldRetryNoChanges({ noChangesRetried: true })).toBe(false);
  });
});

describe("MAX_RUN_RETRIES", () => {
  it("caps general auto-retries", () => {
    expect(MAX_RUN_RETRIES).toBe(3);
  });
});
