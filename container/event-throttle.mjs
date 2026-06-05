// Rate-limits high-frequency event types (e.g. agent.output) so the worker/D1
// isn't flooded. Lifecycle events pass through via alwaysPass.
export function createThrottle(intervalMs, nowFn = () => Date.now(), alwaysPass = new Set()) {
  const last = new Map();
  return (key) => {
    if (alwaysPass.has(key)) return true;
    const now = nowFn();
    const prev = last.get(key) ?? -Infinity;
    if (now - prev >= intervalMs) {
      last.set(key, now);
      return true;
    }
    return false;
  };
}
