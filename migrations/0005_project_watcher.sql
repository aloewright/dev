-- AGPL-3.0-or-later
-- Issue watch state for the autonomous Linear project watcher.

CREATE TABLE IF NOT EXISTS issue_watch_state (
  issue_id              TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES linear_projects(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES app_users(id),
  team_id               TEXT,
  issue_identifier      TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  state_type            TEXT NOT NULL,
  first_seen_started_at TEXT,
  last_run_id           TEXT REFERENCES runs(id),
  last_run_dispatched_at TEXT,
  last_checked_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issue_watch_project_state
  ON issue_watch_state(project_id, state_type);
