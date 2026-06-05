/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { isStalledRun, STALL_THRESHOLD_MS } from "../worker/src/platform/run-liveness";

const now = Date.parse("2026-06-05T12:00:00Z");

describe("isStalledRun", () => {
  it("flags a running run whose last heartbeat is older than the threshold", () => {
    const hb = new Date(now - STALL_THRESHOLD_MS - 1000).toISOString();
    expect(isStalledRun({ status: "running", lastHeartbeatAt: hb }, now)).toBe(true);
  });
  it("does not flag a running run heartbeating within the window", () => {
    const hb = new Date(now - 5000).toISOString();
    expect(isStalledRun({ status: "running", lastHeartbeatAt: hb }, now)).toBe(false);
  });
  it("treats a missing heartbeat on a starting run as stalled", () => {
    expect(isStalledRun({ status: "starting", lastHeartbeatAt: null }, now)).toBe(true);
  });
  it("ignores terminal statuses", () => {
    const hb = new Date(now - STALL_THRESHOLD_MS - 1000).toISOString();
    expect(isStalledRun({ status: "completed", lastHeartbeatAt: hb }, now)).toBe(false);
    expect(isStalledRun({ status: "queued", lastHeartbeatAt: null }, now)).toBe(false);
  });
});
