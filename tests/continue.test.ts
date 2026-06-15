/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import {
  selectExecuteTargets,
  selectTodoExecutionTargets,
  type CreatedWithMeta,
} from "../worker/src/platform/continue";

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

function todo(
  id: string,
  stateType: string,
  priority = 0,
  updatedAt = "2026-06-01T12:00:00Z",
) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Issue ${id}`,
    description: null,
    stateType,
    priority,
    updatedAt,
    teamId: "team_1",
  };
}

describe("selectTodoExecutionTargets", () => {
  it("selects backlog and unstarted issues", () => {
    const picked = selectTodoExecutionTargets(
      [todo("a", "backlog"), todo("b", "unstarted"), todo("c", "started")],
      new Set(),
      10,
    );

    expect(picked.targets.map((issue) => issue.id)).toEqual(["a", "b"]);
    expect(picked.eligibleIssues).toBe(2);
    expect(picked.skippedState).toBe(1);
  });

  it("skips issues that already have an active run", () => {
    const picked = selectTodoExecutionTargets(
      [todo("a", "unstarted"), todo("b", "unstarted")],
      new Set(["a"]),
      10,
    );

    expect(picked.targets.map((issue) => issue.id)).toEqual(["b"]);
    expect(picked.skippedActive).toBe(1);
  });

  it("prioritizes urgent issues and respects the execution cap", () => {
    const picked = selectTodoExecutionTargets(
      [
        todo("low", "unstarted", 4),
        todo("none", "unstarted", 0),
        todo("urgent", "unstarted", 1),
        todo("high", "backlog", 2),
      ],
      new Set(),
      2,
    );

    expect(picked.targets.map((issue) => issue.id)).toEqual(["urgent", "high"]);
    expect(picked.skippedCap).toBe(2);
  });
});
