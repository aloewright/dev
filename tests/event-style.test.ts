/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { eventColor } from "../src/lib/event-style";

describe("eventColor", () => {
  it("maps by event-type prefix", () => {
    expect(eventColor("clone.start")).toBe(eventColor("clone.done"));
    expect(eventColor("agent.output")).toBe("#7ee787");
    expect(eventColor("pr.opened")).toBe("#d2a8ff");
    expect(eventColor("memory.recall")).toBe("#79c0ff");
  });
  it("falls back to a default for unknown prefixes", () => {
    expect(eventColor("weird.thing")).toBe("#8b949e");
    expect(eventColor("")).toBe("#8b949e");
  });
});
