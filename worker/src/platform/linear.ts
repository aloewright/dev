/* AGPL-3.0-or-later */

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export type LinearWriteBack = {
  issueId: string;
  teamId: string | null;
  prUrl: string | null;
  summary: string;
};

// Write the run result back to the Linear issue: comment with the PR, attach the
// PR, and move the issue to a completed state. Best-effort — callers should treat
// failures as non-fatal. See SANDBOX_REVIEW.md §5.
export async function writeBackToLinear(token: string, input: LinearWriteBack): Promise<void> {
  const comment = input.prUrl
    ? `fly-dev opened a pull request: ${input.prUrl}\n\n${input.summary}`.trim()
    : `fly-dev run completed.\n\n${input.summary}`.trim();

  await linearRequest(token, COMMENT_MUTATION, { issueId: input.issueId, body: comment });

  if (input.prUrl) {
    await linearRequest(token, ATTACHMENT_MUTATION, {
      issueId: input.issueId,
      url: input.prUrl,
      title: "Pull request",
    });
  }

  const doneStateId = await resolveDoneState(token, input.teamId);
  if (doneStateId) {
    await linearRequest(token, ISSUE_STATE_MUTATION, { issueId: input.issueId, stateId: doneStateId });
  }
}

export type CreatedLinearIssue = { id: string; identifier: string; url: string; title: string };

// Resolve a team for creating issues in a project. Tries three sources in order:
// 1. project.teams — works for team-scoped projects.
// 2. issueTeamIds — team IDs scraped from the project's existing issues (workspace-
//    level projects have no project.teams but their issues always belong to a team).
// 3. viewer's first team — last resort so issue creation never fails on workspace setups.
export async function resolveProjectTeam(
  token: string,
  projectId: string,
  issueTeamIds: string[] = [],
): Promise<string | null> {
  const data = await linearRequest<{ project?: { teams?: { nodes?: Array<{ id: string }> } } }>(
    token,
    PROJECT_TEAM_QUERY,
    { id: projectId },
  );
  const fromProject = data?.project?.teams?.nodes?.[0]?.id ?? null;
  if (fromProject) return fromProject;

  const fromIssues = issueTeamIds.find(Boolean) ?? null;
  if (fromIssues) return fromIssues;

  // Last resort: viewer's first team.
  const viewer = await linearRequest<{ teams?: { nodes?: Array<{ id: string }> } }>(
    token,
    `{ teams(first: 1) { nodes { id } } }`,
    {},
  );
  return viewer?.teams?.nodes?.[0]?.id ?? null;
}

// Create a Linear issue under a project + team. Returns null when the mutation
// does not report success.
export async function createLinearIssue(
  token: string,
  input: { teamId: string; projectId: string; title: string; description: string; priority: number },
): Promise<CreatedLinearIssue | null> {
  const data = await linearRequest<{
    issueCreate?: {
      success: boolean;
      issue?: { id: string; identifier: string; url: string; title: string } | null;
    };
  }>(token, ISSUE_CREATE_MUTATION, {
    teamId: input.teamId,
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    priority: input.priority,
  });
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) return null;
  return { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title };
}

async function resolveDoneState(token: string, teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  const data = await linearRequest<{ workflowStates?: { nodes?: Array<{ id: string }> } }>(
    token,
    DONE_STATE_QUERY,
    { teamId },
  );
  return data?.workflowStates?.nodes?.[0]?.id ?? null;
}

async function linearRequest<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Surface auth/API failures in observability (tail/logs) instead of swallowing
    // them — a 401 here means the Linear token expired (see getValidLinearToken).
    console.error(`[linear] GraphQL HTTP ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    console.error(`[linear] GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }
  return json.data ?? null;
}

const COMMENT_MUTATION =
  `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
const ATTACHMENT_MUTATION =
  `mutation($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }`;
const ISSUE_STATE_MUTATION =
  `mutation($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }`;
const DONE_STATE_QUERY =
  `query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "completed" } }) { nodes { id name } } }`;
const PROJECT_TEAM_QUERY =
  `query($id: String!) { project(id: $id) { teams(first: 1) { nodes { id } } } }`;
const ISSUE_CREATE_MUTATION =
  `mutation($teamId: String!, $projectId: String!, $title: String!, $description: String!, $priority: Int!) { issueCreate(input: { teamId: $teamId, projectId: $projectId, title: $title, description: $description, priority: $priority }) { success issue { id identifier url title } } }`;
