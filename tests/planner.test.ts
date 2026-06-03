/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { extractJsonPlan, planNextSteps } from "../worker/src/platform/planner";

describe("extractJsonPlan", () => {
  it("parses a fenced json block with reasoning preamble", () => {
    const raw =
      "Let me think... here is the plan:\n```json\n" +
      '{"summary":"Ship auth","issues":[{"title":"Add login","description":"d","priority":2}],"execute":[0]}' +
      "\n```\nDone.";
    const plan = extractJsonPlan(raw);
    expect(plan).toEqual({
      summary: "Ship auth",
      issues: [{ title: "Add login", description: "d", priority: 2 }],
      execute: [0],
    });
  });

  it("caps issues at 6 and drops titleless/invalid entries", () => {
    const issues = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, description: "", priority: 9 }));
    const raw = JSON.stringify({ summary: "", issues: [...issues, { description: "no title" }], execute: [] });
    const plan = extractJsonPlan(raw);
    expect(plan?.issues).toHaveLength(6);
    expect(plan?.issues.every((i) => i.priority === 4)).toBe(true); // 9 clamped to 4
  });

  it("filters execute indexes out of range and dedups", () => {
    const raw = JSON.stringify({
      summary: "s",
      issues: [{ title: "a" }, { title: "b" }],
      execute: [0, 0, 1, 5, -1],
    });
    expect(extractJsonPlan(raw)?.execute).toEqual([0, 1]);
  });

  it("returns null for no JSON / no usable issues", () => {
    expect(extractJsonPlan("no json here")).toBeNull();
    expect(extractJsonPlan(null)).toBeNull();
    expect(extractJsonPlan(JSON.stringify({ summary: "x", issues: [] }))).toBeNull();
  });

  it("handles braces inside string values", () => {
    const raw =
      '{"summary":"step {A} -> {B}","issues":[{"title":"t","description":"","priority":1}],"execute":[]}';
    const plan = extractJsonPlan(raw);
    expect(plan?.summary).toBe("step {A} -> {B}");
    expect(plan?.issues).toHaveLength(1);
  });
});

describe("planNextSteps", () => {
  it("calls the gateway pattern and returns the parsed plan", async () => {
    const seen: { model?: string; opts?: unknown } = {};
    const env = {
      AI_GATEWAY_ID: "x",
      AI: {
        run: async (model: string, _input: unknown, opts: unknown) => {
          seen.model = model;
          seen.opts = opts;
          return {
            choices: [
              {
                message: {
                  content: '{"summary":"go","issues":[{"title":"do it","description":"x","priority":1}],"execute":[0]}',
                },
              },
            ],
          };
        },
      },
    } as never;

    const plan = await planNextSteps(env, {
      name: "Proj",
      description: "desc",
      summary: "sum",
      status: "active",
      openIssues: [],
      repo: "aloewright/fly-dev",
    });

    expect(seen.model).toBe("@cf/openai/gpt-oss-120b");
    expect(seen.opts).toEqual({ gateway: { id: "x" } });
    expect(plan?.issues[0]?.title).toBe("do it");
  });
});
