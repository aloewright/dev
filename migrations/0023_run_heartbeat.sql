-- 0023_run_heartbeat.sql
-- Liveness column: bumped on every container heartbeat/event so the reaper can
-- distinguish a live run from a hung one in minutes instead of ~2 hours.
ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_status_heartbeat ON runs (status, last_heartbeat_at);
