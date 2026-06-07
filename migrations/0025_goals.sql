-- Goals: a user-submitted objective that is decomposed into Linear issues, each
-- dispatched as a run. Groups the resulting runs (linked via runs.metadata_json
-- $.goalId) so the portal can show a goal and its child runs together.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  objective TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'planned', -- planned | dispatched | failed
  issue_count INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_goals_user_created ON goals(user_id, created_at DESC);
