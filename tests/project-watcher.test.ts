/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { shouldDispatchIssue } from "../worker/src/platform/project-watcher";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

const NOW_MS = new Date("2026-06-02T12:00:00Z").getTime();

describe("shouldDispatchIssue", () => {
  it("dispatches a backlog issue with no active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "backlog", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("dispatches an unstarted issue with no active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "unstarted", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("skips a backlog issue that already has an active run", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "backlog", first_seen_started_at: null },
        true,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue that has been in progress for less than 1 hour", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 2h when a merged PR already exists", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 2 * ONE_HOUR_MS).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        true,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 2h with no merged PR (still within 4h window)", () => {
    const firstSeenStartedAt = new Date(NOW_MS - 2 * ONE_HOUR_MS).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("dispatches a started issue at exactly 4h+ with no merged PR", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("dispatch");
  });

  it("skips a started issue at 4h+ when a merged PR exists", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        false,
        true,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("skips a started issue at 4h+ that already has an active run", () => {
    const firstSeenStartedAt = new Date(NOW_MS - FOUR_HOURS_MS - 1).toISOString();
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: firstSeenStartedAt },
        true,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });

  it("returns delete for a completed issue", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "completed", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("delete");
  });

  it("returns delete for a canceled issue", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "canceled", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("delete");
  });

  it("skips a started issue with no first_seen_started_at yet set", () => {
    expect(
      shouldDispatchIssue(
        { state_type: "started", first_seen_started_at: null },
        false,
        false,
        NOW_MS,
      ),
    ).toBe("skip");
  });
});
