/* AGPL-3.0-or-later */

// Forward-compat seam for the future Hindsight memory integration. Produces a
// structured run outcome suitable for a `retain(bank, content, context, ts)` call.
// UNUSED until the memory workstream wires it up — do not delete.
export interface RunForSummary {
  id: string;
  objective: string;
  projectName: string | null;
  status: string;
}
export interface EventForSummary {
  eventType: string;
  message: string;
}
export interface ResultForSummary {
  ok?: boolean;
  prUrl?: string;
  summary?: string;
  error?: string;
}
export interface MemoryRecord {
  bankKey: string;
  content: string;
  outcome: string;
  context: { runId: string; prUrl?: string; error?: string; eventTypes: string[] };
}

export function summarizeRunForMemory(
  run: RunForSummary,
  events: EventForSummary[],
  result: ResultForSummary,
): MemoryRecord {
  return {
    bankKey: run.projectName ?? "default",
    content: `Objective: ${run.objective}\nOutcome: ${run.status}\n${result.summary ?? result.error ?? ""}`.trim(),
    outcome: run.status,
    context: {
      runId: run.id,
      prUrl: result.prUrl,
      error: result.error,
      eventTypes: events.map((e) => e.eventType),
    },
  };
}
