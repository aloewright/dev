-- Core config: the user's global "soul" (identity / values / guardrails) and
-- "rules" (always-follow agent instructions). Injected into goal decomposition
-- and every run prompt. One row per user.
CREATE TABLE IF NOT EXISTS core_config (
  user_id TEXT PRIMARY KEY,
  soul TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
