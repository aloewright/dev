/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { ensureUser, first } from "./data";
import { createTaskRun } from "./orchestration";

// Map inbound provider webhooks to task runs. Runs created here still pass
// through createTaskRun's approval gate (REQUIRE_HUMAN_APPROVAL), so a webhook
// only *queues* work for human review — it never auto-mutates a repo unless
// auto-approval is explicitly enabled. See SANDBOX_REVIEW.md §C item 1.

// Linear: trigger on an Issue entering a "started" state or carrying a `fly-dev`
// label.
export async function dispatchFromLinearWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  if (stringField(payload, "type") !== "Issue") return;
  const action = stringField(payload, "action");
  if (action !== "create" && action !== "update") return;

  const data = asObject(payload.data);
  const state = asObject(data.state);
  const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(asObject) : [];
  const triggered =
    stringField(state, "type") === "started" ||
    labels.some((label) => stringField(label, "name")?.toLowerCase() === "fly-dev");
  if (!triggered) return;

  const issueId = stringField(data, "id");
  const title = stringField(data, "title");
  if (!issueId || !title) return;

  const description = stringField(data, "description") ?? "";
  const team = asObject(data.team);
  const user = await ensureUser(env, {
    email: null,
    name: "Fly Webhook",
    flyUserSlug: "internal",
    authSource: "internal",
  });

  await createTaskRun(env, user, {
    objective: `${title}\n\n${description}`.trim(),
    linearProjectId: stringField(data, "projectId") ?? undefined,
    linearIssueId: issueId,
    linearTeamId: stringField(team, "id") ?? undefined,
    agentProvider: "claude-code",
    source: "linear-webhook",
  });
}

// GitHub triggers:
//  - Comment/review on a PR with `/claude` `/codex` `/fix` `/address` OR a formal
//    review requesting changes → an `address_pr` run (addresses comments, fixes
//    tests, resolves conflicts, merges when green).
//  - Comment on an ISSUE with `/claude` or `/codex` → a fresh implement run.
// Never acts on the fly-dev bot's own comments (avoids loops).
export async function dispatchFromGitHubWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  const repository = asObject(payload.repository);
  const fullName = stringField(repository, "full_name");
  if (!fullName) return;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;

  const comment = asObject(payload.comment);
  const review = asObject(payload.review);
  const issue = asObject(payload.issue);
  const pull = asObject(payload.pull_request);

  const author =
    stringField(asObject(comment.user), "login") ?? stringField(asObject(review.user), "login");
  // Ignore ALL GitHub App bots (our own + code-review bots like CodeRabbit /
  // github-actions). Otherwise a bot's review → our push → bot re-review → … loops
  // forever. Humans still trigger via an explicit /claude /fix /address mention.
  if (author && /\[bot\]/i.test(author)) return;

  const body = stringField(comment, "body") ?? stringField(review, "body") ?? "";
  const reviewState = stringField(review, "state");

  // A PR number is present when this is a comment on a PR (issue.pull_request set)
  // or a pull_request_review(_comment) event (uses payload.pull_request.number).
  const isPrComment = Object.keys(asObject(issue.pull_request)).length > 0;
  const prNumber =
    isPrComment && typeof issue.number === "number"
      ? (issue.number as number)
      : typeof pull.number === "number"
        ? (pull.number as number)
        : null;

  const mentioned = /\/(claude|codex|fix|address)\b/i.test(body);
  const provider: "codex" | "claude-code" = /\/codex\b/i.test(body) ? "codex" : "claude-code";

  // PR feedback → address_pr (only one in-flight per PR to avoid racing pushes).
  if (prNumber && (mentioned || reviewState === "changes_requested")) {
    const inFlight = await first(
      env,
      `SELECT id FROM runs
        WHERE status IN ('queued','running','waiting_approval')
          AND metadata_json LIKE ? AND metadata_json LIKE ? LIMIT 1`,
      [`%"mode":"address_pr"%`, `%"prNumber":${prNumber},%`],
    );
    if (inFlight) return;
    const ask = body.replace(/\/(claude|codex|fix|address)\b/gi, "").trim();
    const user = await ensureUser(env, {
      email: null,
      name: "Fly Webhook",
      flyUserSlug: "internal",
      authSource: "internal",
    });
    await createTaskRun(env, user, {
      objective: `Address review feedback on PR #${prNumber}.${ask ? `\n\n${ask}` : ""}`,
      repoOwner: owner,
      repoName: repo,
      mode: "address_pr",
      prNumber,
      agentProvider: provider,
      source: "github-pr-comment",
    });
    return;
  }

  // Issue comment with an explicit trigger → fresh implement run.
  if (!mentioned || !/\/(claude|codex)\b/i.test(body)) return;
  const title = stringField(issue, "title");
  if (!title) return;
  const user = await ensureUser(env, {
    email: null,
    name: "Fly Webhook",
    flyUserSlug: "internal",
    authSource: "internal",
  });
  await createTaskRun(env, user, {
    objective: `${title}\n\n${body.replace(/\/(claude|codex)\b/gi, "").trim()}`.trim(),
    repoOwner: owner,
    repoName: repo,
    agentProvider: provider,
    source: "github-webhook",
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
