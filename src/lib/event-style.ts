/* AGPL-3.0-or-later */

// Terminal-log accent color per event-type prefix. Open set: a new prefix (e.g.
// memory.*) just needs an entry; unknowns get the neutral default.
const PREFIX_COLORS: Record<string, string> = {
  clone: "#58a6ff",
  agent: "#7ee787",
  tests: "#f2cc60",
  push: "#ffa657",
  pr: "#d2a8ff",
  memory: "#79c0ff",
  run: "#8b949e",
  container: "#58a6ff",
  heartbeat: "#484f58",
};

export function eventColor(eventType: string): string {
  const prefix = eventType.split(".")[0] ?? "";
  return PREFIX_COLORS[prefix] ?? "#8b949e";
}
