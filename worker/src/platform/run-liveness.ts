/* AGPL-3.0-or-later */

// A run is "active" (occupies a container slot) while starting or running.
export const ACTIVE_STATUSES = ["starting", "running"] as const;

// No heartbeat within this window ⇒ the container is presumed dead. Container
// emits a heartbeat every ~15s, so 8 minutes tolerates ~30 missed beats.
export const STALL_THRESHOLD_MS = 8 * 60 * 1000;

export interface RunLiveness {
  status: string;
  lastHeartbeatAt: string | null;
}

export function isStalledRun(run: RunLiveness, nowMs: number): boolean {
  if (!ACTIVE_STATUSES.includes(run.status as (typeof ACTIVE_STATUSES)[number])) {
    return false;
  }
  if (!run.lastHeartbeatAt) return true;
  const hb = Date.parse(run.lastHeartbeatAt);
  if (Number.isNaN(hb)) return true;
  return nowMs - hb > STALL_THRESHOLD_MS;
}
