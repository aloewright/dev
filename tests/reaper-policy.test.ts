/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import {
  isRetryableError,
  shouldRetryNoChanges,
  MAX_RUN_RETRIES,
  MAX_STUCK_REDISPATCH,
  reapKind,
  reapBudgetField,
  reapBudgetCap,
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

describe("reap budgets (capacity waits are not failures)", () => {
  it("classifies queued/running as stuck (capacity) and failed as error", () => {
    expect(reapKind("queued")).toBe("stuck");
    expect(reapKind("running")).toBe("stuck");
    expect(reapKind("failed")).toBe("error");
  });

  it("routes the two kinds to separate metadata counters", () => {
    expect(reapBudgetField("stuck")).toBe("stuckRedispatch");
    expect(reapBudgetField("error")).toBe("retryCount");
  });

  it("gives capacity re-dispatches a far more generous cap than error retries", () => {
    expect(reapBudgetCap("error")).toBe(MAX_RUN_RETRIES);
    expect(reapBudgetCap("stuck")).toBe(MAX_STUCK_REDISPATCH);
    expect(MAX_STUCK_REDISPATCH).toBeGreaterThan(MAX_RUN_RETRIES);
  });
});
