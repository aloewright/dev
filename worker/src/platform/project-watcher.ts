/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { all, ensureUser, first, runSql } from "./data";
import { getLinearProjectIssues } from "./integrations";
import { findMergedPrForIssue } from "./github";
import { createTaskRun } from "./orchestration";

export type IssueWatchRow = {
  issue_id: string;
  project_id: string;
  user_id: string;
  team_id: string | null;
  issue_identifier: string;
  title: string;
  description: string | null;
  state_type: string;
  first_seen_started_at: string | null;
  last_run_id: string | null;
  last_run_dispatched_at: string | null;
  last_checked_at: string;
  updated_at: string;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;
const MAX_CONCURRENT_RUNS = 5;

// Pure dispatch decision — no I/O. Determines what the watcher should do for
// a given issue row given the current context.
export function shouldDispatchIssue(
  row: Pick<IssueWatchRow, "state_type" | "first_seen_started_at">,
  hasActiveRun: boolean,
  hasMergedPr: boolean,
  nowMs: number,
): "dispatch" | "skip" | "delete" {
  if (row.state_type === "completed" || row.state_type === "canceled") return "delete";
  if (hasActiveRun) return "skip";
  if (row.state_type === "backlog" || row.state_type === "unstarted") return "dispatch";
  if (row.state_type === "started") {
    if (!row.first_seen_started_at) return "skip";
    const elapsedMs = nowMs - new Date(row.first_seen_started_at).getTime();
    if (elapsedMs < ONE_HOUR_MS) return "skip";
    if (hasMergedPr) return "skip";
    if (elapsedMs < FOUR_HOURS_MS) return "skip";
    return "dispatch";
  }
  return "skip";
}

export async function runProjectWatcher(env: Env): Promise<void> {
  try {
    // Enforce global concurrency cap to avoid overwhelming the container fleet.
    const cap = await first<{ cnt: number }>(
      env,
      "SELECT COUNT(*) as cnt FROM runs WHERE status IN ('queued', 'running', 'waiting_approval')",
      [],
    );
    if ((cap?.cnt ?? 0) >= MAX_CONCURRENT_RUNS) {
      console.log("[watcher] concurrency cap reached, skipping tick");
      return;
    }

    // Use a synthetic internal user as the run owner (same identity as webhooks).
    const internalUser = await ensureUser(env, {
      email: null,
      name: "Fly Watcher",
      flyUserSlug: "internal",
      authSource: "internal",
    });

    // Find all users with an active Linear OAuth connection.
    const connections = await all<{ user_id: string }>(
      env,
      "SELECT user_id FROM account_connections WHERE provider = 'linear' AND status = 'connected'",
      [],
    );
    if (connections.length === 0) return;

    // Use the first connected user's token to fetch all Linear projects.
    // linear_projects is a shared table with no user_id FK; the first active
    // connection is sufficient for a single-workspace setup.
    const firstConnection = connections[0];
    if (!firstConnection) return;
    const userId = firstConnection.user_id;

    const projects = await all<{ id: string }>(
      env,
      "SELECT id FROM linear_projects",
      [],
    );

    for (const project of projects) {
      try {
        await watchProject(env, userId, project.id, internalUser);
      } catch (err) {
        console.warn(`[watcher] project ${project.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[watcher] top-level error:", err);
  }
}

async function watchProject(
  env: Env,
  userId: string,
  projectId: string,
  internalUser: Awaited<ReturnType<typeof ensureUser>>,
): Promise<void> {
  const { issues, reason } = await getLinearProjectIssues(env, userId, projectId);
  if (reason || issues.length === 0) return;

  const now = new Date().toISOString();
  const returnedIds = new Set(issues.map((i) => i.id));

  // Upsert each returned issue. Sets first_seen_started_at only once (on first
  // transition into 'started'). All other fields are kept current.
  for (const issue of issues) {
    await runSql(
      env,
      `INSERT INTO issue_watch_state
         (issue_id, project_id, user_id, team_id, issue_identifier, title, description,
          state_type, last_checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         state_type    = excluded.state_type,
         title         = excluded.title,
         team_id       = COALESCE(excluded.team_id, team_id),
         last_checked_at = excluded.last_checked_at,
         updated_at    = excluded.updated_at,
         first_seen_started_at = CASE
           WHEN excluded.state_type = 'started' AND first_seen_started_at IS NULL
           THEN excluded.last_checked_at
           ELSE first_seen_started_at
         END`,
      [
        issue.id,
        projectId,
        userId,
        issue.teamId ?? null,
        issue.identifier,
        issue.title,
        null,
        issue.stateType,
        now,
        now,
      ],
    );
  }

  // Reconcile: delete rows for issues that disappeared from Linear (completed,
  // canceled, or deleted). getLinearProjectIssues already excludes completed/
  // canceled via its filter, so vanished rows are safe to drop.
  const existingRows = await all<{ issue_id: string }>(
    env,
    "SELECT issue_id FROM issue_watch_state WHERE project_id = ?",
    [projectId],
  );
  for (const row of existingRows) {
    if (!returnedIds.has(row.issue_id)) {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
    }
  }

  // Fetch the repo mapping once for this project (needed for PR check).
  const repoMapping = await first<{ owner: string; repo: string }>(
    env,
    "SELECT owner, repo FROM repository_mappings WHERE linear_project_id = ? AND status = 'active' LIMIT 1",
    [projectId],
  );

  // Apply dispatch rules to each watched issue.
  const watchRows = await all<IssueWatchRow>(
    env,
    "SELECT * FROM issue_watch_state WHERE project_id = ?",
    [projectId],
  );

  const nowMs = Date.now();

  for (const row of watchRows) {
    if (row.state_type === "completed" || row.state_type === "canceled") {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
      continue;
    }

    const activeRun = await first<{ id: string }>(
      env,
      "SELECT id FROM runs WHERE linear_issue_id = ? AND status IN ('queued', 'running', 'waiting_approval')",
      [row.issue_id],
    );
    const hasActiveRun = Boolean(activeRun);

    // Only check GitHub PR for started issues that have crossed the 1h mark.
    let hasMergedPr = false;
    if (
      row.state_type === "started" &&
      row.first_seen_started_at &&
      repoMapping &&
      !hasActiveRun
    ) {
      const elapsedMs = nowMs - new Date(row.first_seen_started_at).getTime();
      if (elapsedMs >= ONE_HOUR_MS) {
        hasMergedPr = await findMergedPrForIssue(
          env,
          repoMapping.owner,
          repoMapping.repo,
          row.issue_identifier,
        );
      }
    }

    const decision = shouldDispatchIssue(row, hasActiveRun, hasMergedPr, nowMs);
    if (decision === "delete") {
      await runSql(env, "DELETE FROM issue_watch_state WHERE issue_id = ?", [row.issue_id]);
      continue;
    }
    if (decision !== "dispatch") continue;

    const resp = await createTaskRun(env, internalUser, {
      objective: `${row.title}${row.description ? `\n\n${row.description}` : ""}`.trim(),
      linearProjectId: row.project_id,
      linearIssueId: row.issue_id,
      linearTeamId: row.team_id ?? undefined,
      agentProvider: "claude-code",
      autonomyMode: "auto_eligible",
      source: "project-watcher",
    });

    if (resp.status === 201) {
      const data = (await resp.json()) as { id: string };
      await runSql(
        env,
        "UPDATE issue_watch_state SET last_run_id = ?, last_run_dispatched_at = ?, updated_at = ? WHERE issue_id = ?",
        [data.id, new Date().toISOString(), new Date().toISOString(), row.issue_id],
      );
      console.log(`[watcher] dispatched run ${data.id} for issue ${row.issue_identifier}`);
    }
  }
}
