/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { first, id, recordUsage, runSql } from "./data";
import { redactSecrets } from "./crypto";
import { getLinearProjectIssues, getValidLinearToken } from "./integrations";
import { planGoal, type ProjectContext } from "./planner";
import { createLinearIssue, resolveProjectTeam, type CreatedLinearIssue } from "./linear";
import { createAutonomousRun } from "./orchestration";
import { activeRepo, executeCap } from "./continue";

export type GoalResult = {
  goalId: string;
  summary: string;
  createdIssues: CreatedLinearIssue[];
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};

// Goal intake: decompose a free-text objective into Linear issues under the chosen
// project and dispatch a run per issue to the sandbox VMs. The project (and its
// mapped GitHub repo) are selected at intake, so every child run has a real repo to
// act on — which is what was missing when bare goals were submitted as a single
// repo-less run.
export async function runGoal(
  env: Env,
  user: CurrentUser,
  payload: { objective?: string; linearProjectId?: string },
): Promise<Response> {
  const objective = redactSecrets((payload.objective ?? "").trim());
  if (objective.length < 4) {
    return Response.json({ error: "A goal description is required" }, { status: 400 });
  }
  const projectId = payload.linearProjectId;
  if (!projectId) {
    return Response.json({ error: "Select a Linear project for this goal", needsProject: true }, { status: 400 });
  }

  const project = await first<{ id: string; name: string; summary: string | null; status: string }>(
    env,
    "SELECT id, name, summary, status FROM linear_projects WHERE id = ?",
    [projectId],
  );
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const repo = await activeRepo(env, projectId);
  if (!repo) {
    return Response.json(
      { error: "No GitHub repo is mapped to this project. Map a repo in Linear Projects first.", needsRepo: true },
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

  const { issues: openIssues } = await getLinearProjectIssues(env, user.id, projectId);

  const ctx: ProjectContext = {
    name: project.name,
    description: "",
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

  const plan = await planGoal(env, ctx, objective);
  if (!plan) {
    return Response.json({ error: "Could not break this goal into tasks. Try rephrasing it." }, { status: 502 });
  }

  const teamIds = openIssues.map((i) => i.teamId).filter((t): t is string => Boolean(t));
  const teamId = await resolveProjectTeam(linearToken, projectId, teamIds);
  if (!teamId) {
    return Response.json({ error: "Could not resolve a Linear team for this project" }, { status: 502 });
  }

  // Persist the goal up-front so it shows in history even if some issue/run
  // creation later fails.
  const goalId = id("goal");
  await runSql(
    env,
    "INSERT INTO goals (id, user_id, project_id, objective, summary, status) VALUES (?, ?, ?, ?, ?, 'planned')",
    [goalId, user.id, projectId, objective, plan.summary || null],
  );

  const createdIssues: CreatedLinearIssue[] = [];
  const descriptions = new Map<string, string>();
  for (const planned of plan.issues) {
    const issue = await createLinearIssue(linearToken, {
      teamId,
      projectId,
      title: planned.title,
      description: planned.description,
      priority: planned.priority,
    });
    if (issue) {
      createdIssues.push(issue);
      descriptions.set(issue.id, planned.description);
    }
  }

  // Dispatch a run per created issue, capped so one goal can't flood the queue.
  const cap = executeCap(env);
  const targets = createdIssues.slice(0, cap);
  const queuedRuns: Array<{ id: string; issue: string }> = [];
  for (const issue of targets) {
    const run = await createAutonomousRun(env, user, {
      objective: `${issue.title}\n\n${descriptions.get(issue.id) ?? ""}`.trim(),
      linearProjectId: projectId,
      linearIssueId: issue.id,
      linearTeamId: teamId,
      goalId,
      agentProvider: "claude-code",
      source: "goal",
    }).catch(() => null);
    if (run && run.status === "queued") queuedRuns.push({ id: run.id, issue: issue.identifier });
  }

  await runSql(
    env,
    "UPDATE goals SET status = ?, issue_count = ?, run_count = ? WHERE id = ?",
    [queuedRuns.length > 0 ? "dispatched" : "planned", createdIssues.length, queuedRuns.length, goalId],
  );
  await recordUsage(env, user.id, "goal_decomposed", {
    projectId,
    metadata: { goalId, issues: createdIssues.length, runs: queuedRuns.length },
  }).catch(() => undefined);

  return Response.json({
    goalId,
    summary: plan.summary,
    createdIssues,
    queuedRuns,
    skipped: Math.max(0, createdIssues.length - targets.length),
  } satisfies GoalResult);
}

export type GoalSummaryRow = {
  id: string;
  objective: string;
  summary: string | null;
  status: string;
  issueCount: number;
  runCount: number;
  createdAt: string;
  projectName: string | null;
};

// Recent goals with their live run tally (runs are linked via metadata_json.goalId).
export async function listGoals(env: Env, user: CurrentUser): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.objective, g.summary, g.status, g.issue_count AS issueCount,
            g.created_at AS createdAt, p.name AS projectName,
            (SELECT COUNT(*) FROM runs r
               WHERE json_extract(r.metadata_json, '$.goalId') = g.id) AS runCount
       FROM goals g
       LEFT JOIN linear_projects p ON p.id = g.project_id
      WHERE g.user_id = ?
      ORDER BY g.created_at DESC
      LIMIT 20`,
  )
    .bind(user.id)
    .all<GoalSummaryRow>();
  return Response.json({ goals: rows.results ?? [] });
}
