/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { first } from "./data";
import { autoMapProjects, getLinearProjectIssues, getValidLinearToken } from "./integrations";
import { planNextSteps, type ProjectContext } from "./planner";
import { createLinearIssue, resolveProjectTeam, type CreatedLinearIssue } from "./linear";
import { createAutonomousRun } from "./orchestration";

const DEFAULT_EXECUTE_CAP = 3;
const MAX_EXECUTE_CAP = 10; // hard ceiling so a misconfigured env var can't start a flood of runs

export type CreatedWithMeta = {
  planIndex: number;
  priority: number;
  description: string;
  issue: CreatedLinearIssue;
};

export type ContinueResult = {
  summary: string;
  createdIssues: CreatedLinearIssue[];
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};

// Choose which created issues to execute: prefer the planner's `execute` indexes
// (those that actually got created), else fall back to highest priority. Capped.
export function selectExecuteTargets(
  executeIndexes: number[],
  created: CreatedWithMeta[],
  cap: number,
): CreatedWithMeta[] {
  const wanted = new Set(executeIndexes);
  let pool = created.filter((c) => wanted.has(c.planIndex));
  if (pool.length === 0) {
    pool = [...created].sort((a, b) => a.priority - b.priority); // 1=urgent first
  }
  return pool.slice(0, Math.max(0, cap));
}

export async function continueProject(env: Env, user: CurrentUser, projectId: string): Promise<Response> {
  // 1. Review: project + repo mapping + open issues.
  const project = await first<{
    id: string;
    name: string;
    description: string | null;
    summary: string | null;
    status: string;
  }>(env, "SELECT id, name, description, summary, status FROM linear_projects WHERE id = ?", [projectId]);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  let repo = await activeRepo(env, projectId);
  if (!repo) {
    await autoMapProjects(env, user.id).catch(() => undefined);
    repo = await activeRepo(env, projectId);
  }
  if (!repo) {
    return Response.json(
      { error: "No GitHub repo mapped to this project. Map a repo first.", needsRepo: true },
      { status: 409 },
    );
  }

  const linearToken = await getValidLinearToken(env, user.id);
  if (!linearToken) {
    return Response.json(
      { error: "Linear session expired — reconnect Linear in Connections.", needsReconnect: true },
      { status: 400 },
    );
  }

  // The Linear token was validated just above, so getLinearProjectIssues won't
  // return a "not connected" reason here; on a transient GraphQL error it yields an
  // empty list and the planner simply proceeds with no open-issue context.
  const { issues: openIssues } = await getLinearProjectIssues(env, user.id, projectId);

  // 2. Plan.
  const ctx: ProjectContext = {
    name: project.name,
    description: project.description ?? "",
    summary: project.summary ?? "",
    status: project.status,
    openIssues: openIssues.map((i) => ({
      identifier: i.identifier,
      title: i.title,
      state: i.state,
      priority: i.priority,
    })),
    repo: `${repo.owner}/${repo.repo}`,
  };
  const plan = await planNextSteps(env, ctx);
  if (!plan) {
    return Response.json({ error: "Planner returned no usable plan" }, { status: 502 });
  }

  // 3. Break down into Linear issues, remembering each one's plan index.
  // Pass existing issue team IDs as fallback for workspace-level projects where
  // project.teams is empty.
  const issueTeamIds = openIssues.map((i) => i.teamId).filter((id): id is string => Boolean(id));
  const teamId = await resolveProjectTeam(linearToken, projectId, issueTeamIds);
  if (!teamId) {
    return Response.json({ error: "Could not resolve a Linear team for this project" }, { status: 502 });
  }
  const created: CreatedWithMeta[] = [];
  for (let planIndex = 0; planIndex < plan.issues.length; planIndex += 1) {
    const planned = plan.issues[planIndex];
    if (!planned) continue; // noUncheckedIndexedAccess narrowing; never null at runtime
    const issue = await createLinearIssue(linearToken, {
      teamId,
      projectId,
      title: planned.title,
      description: planned.description,
      priority: planned.priority,
    });
    if (issue) {
      created.push({ planIndex, priority: planned.priority, description: planned.description, issue });
    }
  }

  // 4. Execute the selected subset (autonomous when CONTINUE_AUTONOMY is on).
  const targets = selectExecuteTargets(plan.execute, created, executeCap(env));
  const queuedRuns: Array<{ id: string; issue: string }> = [];
  for (const target of targets) {
    const run = await createAutonomousRun(env, user, {
      objective: `${target.issue.title}\n\n${target.description}`.trim(),
      linearProjectId: projectId,
      linearIssueId: target.issue.id,
      linearTeamId: teamId,
      agentProvider: "claude-code",
      source: "continue",
    }).catch(() => null);
    // Only count runs that actually queued. With CONTINUE_AUTONOMY off, the run is
    // left waiting_approval (not started), so it must not be reported as a started run.
    if (run && run.status === "queued") queuedRuns.push({ id: run.id, issue: target.issue.identifier });
  }

  return Response.json({
    summary: plan.summary,
    createdIssues: created.map((c) => c.issue),
    queuedRuns,
    skipped: Math.max(0, created.length - targets.length),
  } satisfies ContinueResult);
}

export async function activeRepo(env: Env, projectId: string): Promise<{ owner: string; repo: string } | null> {
  return first<{ owner: string; repo: string }>(
    env,
    "SELECT owner, repo FROM repository_mappings WHERE linear_project_id = ? AND status = 'active' ORDER BY confidence DESC LIMIT 1",
    [projectId],
  );
}

export function executeCap(env: Env): number {
  const n = Number.parseInt(env.CONTINUE_EXECUTE_CAP ?? "", 10);
  const cap = Number.isInteger(n) && n > 0 ? n : DEFAULT_EXECUTE_CAP;
  return Math.min(cap, MAX_EXECUTE_CAP);
}
