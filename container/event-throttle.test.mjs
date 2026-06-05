import { describe, expect, it } from "vitest";
import { createThrottle } from "./event-throttle.mjs";

describe("createThrottle", () => {
  it("allows the first call and blocks within the interval", () => {
    let now = 1000;
    const t = createThrottle(1000, () => now);
    expect(t("agent.output")).toBe(true);
    now = 1500;
    expect(t("agent.output")).toBe(false);
    now = 2001;
    expect(t("agent.output")).toBe(true);
  });
  it("throttles per key independently", () => {
    let now = 0;
    const t = createThrottle(1000, () => now);
    expect(t("a")).toBe(true);
    expect(t("b")).toBe(true);
  });
  it("never throttles keys in the always-pass set", () => {
    let now = 0;
    const t = createThrottle(1000, () => now, new Set(["clone.start"]));
    expect(t("clone.start")).toBe(true);
    expect(t("clone.start")).toBe(true);
  });
});
