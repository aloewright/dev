/* AGPL-3.0-or-later */
import type { Env } from "../env";

export type PlannedIssue = { title: string; description: string; priority: number };
export type NextStepPlan = { summary: string; issues: PlannedIssue[]; execute: number[] };

export type ProjectContext = {
  name: string;
  description: string;
  summary: string;
  status: string;
  openIssues: Array<{ identifier: string; title: string; state: string; priority: number }>;
  repo: string | null;
};

const MAX_ISSUES = 6;

// Route through Cloudflare AI Gateway using the sanctioned worker-side pattern
// (env.AI.run with a concrete @cf model id + gateway option). Dynamic routes
// (dynamic/research_gen) are NOT resolvable from inside a Worker today — see
// ~/.claude/CLAUDE.md "Inside a Worker". Swap back to a dynamic route when fixed.
const PLANNER_MODEL = "@cf/openai/gpt-oss-120b";
// Goal decomposition uses NVIDIA Nemotron on Workers AI — a stronger reasoning
// model for turning a free-text goal into well-scoped Linear issues.
const GOAL_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";
const PLANNER_MAX_TOKENS = 2048;

const PLANNER_SYSTEM =
  "You are a senior engineering lead. Given a software project's description and its " +
  "open issues, decide the best next steps. Respond with ONLY a JSON object, no prose, " +
  'of the form {"summary": string, "issues": [{"title": string, "description": string, ' +
  '"priority": 1-4}], "execute": number[]}. priority: 1=urgent,2=high,3=medium,4=low. ' +
  "issues: the concrete next pieces of work (max 6), each a self-contained task an " +
  "autonomous coding agent could implement and open a PR for. execute: indexes into " +
  "issues that should begin immediately. Do not duplicate work already covered by an open issue.";

export async function planNextSteps(env: Env, ctx: ProjectContext): Promise<NextStepPlan | null> {
  return runPlanner(env, PLANNER_SYSTEM, buildPlannerPrompt(ctx), [PLANNER_MODEL]);
}

const GOAL_SYSTEM =
  "You are a senior engineering lead. Break the user's GOAL into a concrete, ordered " +
  "set of self-contained engineering tasks that an autonomous coding agent can each " +
  "implement and open a PR for, against the given repository. Respond with ONLY a JSON " +
  'object, no prose, of the form {"summary": string, "issues": [{"title": string, ' +
  '"description": string, "priority": 1-4}], "execute": number[]}. priority: ' +
  "1=urgent,2=high,3=medium,4=low. issues: max 6, each a single PR-sized task with " +
  "enough detail (files/areas, acceptance criteria) for an agent to act without further " +
  "questions. execute: indexes of issues to start immediately (default: all of them). " +
  "Do not duplicate work already covered by an existing open issue.";

// Decompose a free-text GOAL (not a project's standing state) into issues. Used by
// the goal-intake pipeline; reuses the same JSON contract as planNextSteps.
export async function planGoal(env: Env, ctx: ProjectContext, goal: string, core = ""): Promise<NextStepPlan | null> {
  // Prefer Nemotron; fall back to the proven gpt-oss model if Nemotron errors or
  // returns nothing usable through the binding, so goal decomposition never
  // dead-ends with "couldn't break this goal into tasks". The user's global core
  // (soul + rules) is prepended to the system prompt when present.
  const system = core ? `${core}\n\n${GOAL_SYSTEM}` : GOAL_SYSTEM;
  return runPlanner(env, system, buildGoalPrompt(ctx, goal), [GOAL_MODEL, PLANNER_MODEL]);
}

async function runPlanner(
  env: Env,
  system: string,
  userPrompt: string,
  models: string[],
): Promise<NextStepPlan | null> {
  // Try each model in order; the first that yields a usable plan wins.
  for (const model of models) {
    const plan = await runOnePlanner(env, system, userPrompt, model);
    if (plan) return plan;
  }
  return null;
}

async function runOnePlanner(
  env: Env,
  system: string,
  userPrompt: string,
  model: string,
): Promise<NextStepPlan | null> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  let raw: unknown;
  try {
    raw = await (
      env.AI as unknown as {
        run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
      }
    ).run(
      model,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        max_tokens: PLANNER_MAX_TOKENS,
      },
      { gateway: { id: gatewayId } },
    );
  } catch {
    // AI gateway error/timeout — treat as "no usable plan" so the caller can fall
    // back to the next model (and ultimately return a clean 502, not a 500).
    return null;
  }
  return extractJsonPlan(readContent(raw));
}

function buildGoalPrompt(ctx: ProjectContext, goal: string): string {
  const issues = ctx.openIssues.length
    ? ctx.openIssues.map((i) => `- [${i.identifier}] ${i.title} (${i.state})`).join("\n")
    : "(none)";
  return [
    `GOAL:\n${goal}`,
    "",
    `Repository: ${ctx.repo ?? "(unmapped)"}`,
    `Project: ${ctx.name}`,
    `Project summary: ${ctx.summary || "(none)"}`,
    `Existing open issues (avoid duplicating):\n${issues}`,
    "",
    "Produce the JSON plan that accomplishes the GOAL now.",
  ].join("\n");
}

function buildPlannerPrompt(ctx: ProjectContext): string {
  const issues = ctx.openIssues.length
    ? ctx.openIssues.map((i) => `- [${i.identifier}] ${i.title} (${i.state})`).join("\n")
    : "(none)";
  return [
    `Project: ${ctx.name}`,
    `Status: ${ctx.status}`,
    `Repository: ${ctx.repo ?? "(unmapped)"}`,
    `Summary: ${ctx.summary || "(none)"}`,
    `Description:\n${ctx.description || "(none)"}`,
    `Open issues:\n${issues}`,
    "",
    "Produce the JSON plan now.",
  ].join("\n");
}

// The AI binding returns either the OpenAI-style `choices[0].message.content`
// (gpt-oss, and Nemotron via REST) or the Workers AI native `{ response }` shape,
// depending on the model. Read both so a model isn't silently dropped to null.
function readContent(raw: unknown): string | null {
  const r = raw as {
    choices?: Array<{ message?: { content?: string | null } }>;
    response?: unknown;
  };
  const fromChoices = r?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) return fromChoices;
  if (typeof r?.response === "string" && r.response.trim()) return r.response;
  return null;
}

// Parse the model's text into a NextStepPlan. Tolerates ```json fences and
// reasoning preambles by extracting the first balanced {...} block. Returns null
// when there is no usable plan (no JSON, or zero valid issues).
export function extractJsonPlan(raw: string | null | undefined): NextStepPlan | null {
  if (!raw) return null;
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const issues: PlannedIssue[] = [];
  for (const item of Array.isArray(obj.issues) ? obj.issues : []) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title) continue;
    issues.push({
      title,
      description: typeof i.description === "string" ? i.description : "",
      priority: clampPriority(i.priority),
    });
    if (issues.length >= MAX_ISSUES) break;
  }
  if (issues.length === 0) return null;

  const execute = (Array.isArray(obj.execute) ? obj.execute : [])
    .map((n) => (typeof n === "number" ? Math.trunc(n) : Number.NaN))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < issues.length);

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    issues,
    execute: [...new Set(execute)],
  };
}

function clampPriority(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : 3;
  return Math.min(Math.max(n, 1), 4);
}

// First balanced top-level JSON object in arbitrary text (string-aware so braces
// inside strings don't throw off the depth count).
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
