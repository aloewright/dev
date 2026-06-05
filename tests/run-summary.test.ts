/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { summarizeRunForMemory } from "../worker/src/platform/run-summary";

describe("summarizeRunForMemory", () => {
  it("produces a structured memory record from a run + events + result", () => {
    const out = summarizeRunForMemory(
      { id: "run_1", objective: "Add X", projectName: "Proj", status: "completed" },
      [{ eventType: "agent.start", message: "" }, { eventType: "pr.opened", message: "#42" }],
      { ok: true, prUrl: "https://github.com/o/r/pull/42", summary: "did the thing" },
    );
    expect(out.bankKey).toBe("Proj");
    expect(out.content).toContain("Add X");
    expect(out.outcome).toBe("completed");
    expect(out.context.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(out.context.eventTypes).toContain("pr.opened");
  });
});
