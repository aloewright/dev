/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { selectExecuteTargets, type CreatedWithMeta } from "../worker/src/platform/continue";

function made(planIndex: number, priority: number): CreatedWithMeta {
  return {
    planIndex,
    priority,
    description: "",
    issue: { id: `i${planIndex}`, identifier: `E-${planIndex}`, url: "u", title: `t${planIndex}` },
  };
}

describe("selectExecuteTargets", () => {
  it("prefers the planner's execute indexes, capped", () => {
    const created = [made(0, 3), made(1, 1), made(2, 2)];
    const picked = selectExecuteTargets([2, 0], created, 3);
    expect(picked.map((p) => p.planIndex)).toEqual([0, 2]); // filtered in created-order
  });

  it("caps the number of targets", () => {
    const created = [made(0, 1), made(1, 1), made(2, 1), made(3, 1)];
    expect(selectExecuteTargets([0, 1, 2, 3], created, 2)).toHaveLength(2);
  });

  it("falls back to top priority when execute is empty", () => {
    const created = [made(0, 4), made(1, 1), made(2, 2)];
    const picked = selectExecuteTargets([], created, 2);
    expect(picked.map((p) => p.planIndex)).toEqual([1, 2]); // priority 1 then 2
  });

  it("ignores execute indexes with no created issue (creation failed)", () => {
    const created = [made(0, 2), made(2, 2)]; // index 1 failed to create
    const picked = selectExecuteTargets([1], created, 3);
    // no created issue matches index 1 -> fall back to top priority
    expect(picked.map((p) => p.planIndex)).toEqual([0, 2]);
  });
});
