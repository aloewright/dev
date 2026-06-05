/* AGPL-3.0-or-later */
// Swappable agent-memory layer. Backed today by a self-hosted Hindsight server
// (see infra/hindsight/), but every call site depends only on MemoryProvider, so
// the engine can be replaced without touching the run pipeline. Memory is strictly
// best-effort: no method here may throw into a run path (recall fails to empty,
// retain is fire-and-enqueue). See the plan + [[fly-dev-hindsight-integration]].

import type { Env, MemoryRetainMessage } from "../../env";
import { HindsightMemoryProvider } from "./hindsight";

export type BankKey = string;

export interface RetainInput {
  bank: BankKey;
  content: string;
  context: Record<string, unknown>; // serialized to a compact string for Hindsight; full object kept in the D1 mirror
  tags?: string[];
  ts?: number; // epoch ms
}
export interface RetainResult {
  ok: boolean;
  hindsightId?: string | null;
  error?: string;
}

export interface RecallInput {
  bank: BankKey;
  query: string;
  limit?: number;
}
export interface RecalledMemory {
  id?: string;
  text: string;
  type?: string;
}
export interface RecallResult {
  ok: boolean;
  memories: RecalledMemory[];
  error?: string;
}

export interface ReflectInput {
  bank: BankKey;
  query: string;
}
export interface ReflectResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface MentalModelResult {
  content: string;
  name?: string;
}

export interface MemoryProvider {
  retain(input: RetainInput): Promise<RetainResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  reflect(input: ReflectInput): Promise<ReflectResult>;
  /** The standing "project playbook" mental model for a bank, or null. Best-effort. */
  mentalModel(bank: BankKey): Promise<MentalModelResult | null>;
  /** Idempotently create the bank config + standing mental model. Safe to call repeatedly. */
  ensureBank(bank: BankKey): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

// Disabled / unreachable fallback. recall returns ok:true + empty so call sites
// never branch — "memory off" looks identical to "no memories yet".
export class NoopMemoryProvider implements MemoryProvider {
  async retain(): Promise<RetainResult> {
    return { ok: false, error: "memory_disabled" };
  }
  async recall(): Promise<RecallResult> {
    return { ok: true, memories: [] };
  }
  async reflect(): Promise<ReflectResult> {
    return { ok: false, error: "memory_disabled" };
  }
  async mentalModel(): Promise<MentalModelResult | null> {
    return null;
  }
  async ensureBank(): Promise<void> {
    /* no-op */
  }
  async health() {
    return { ok: false, detail: "disabled" };
  }
}

export function getMemoryProvider(env: Env): MemoryProvider {
  if (env.MEMORY_ENABLED !== "true" || !env.HINDSIGHT_BASE_URL) {
    return new NoopMemoryProvider();
  }
  return new HindsightMemoryProvider({
    baseUrl: env.HINDSIGHT_BASE_URL,
    apiKey: env.HINDSIGHT_API_KEY,
    cfAccessClientId: env.HINDSIGHT_CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: env.HINDSIGHT_CF_ACCESS_CLIENT_SECRET,
  });
}

// Bank id = stable user id + project scope. Uses app_users.id (immutable within an
// auth regime, the FK every user-scoped table already uses), NOT the mutable
// fly_user_slug, and the project_id, NOT the human-renamable project name.
// See [[fly-dev-identity-orphaning]].
export function bankKeyFor(userId: string, projectId?: string | null): BankKey {
  return projectId ? `u:${userId}:p:${projectId}` : `u:${userId}:default`;
}

// Renders recalled memories + the standing mental model into a compact, clearly
// delimited block to prepend to the agent prompt. Returns "" when there's nothing.
export function formatRecallForPrompt(
  recalled: RecallResult,
  playbook: MentalModelResult | null,
): string {
  const lines: string[] = [];
  if (playbook?.content?.trim()) {
    lines.push("## Project memory — playbook", playbook.content.trim());
  }
  const mems = recalled.memories.filter((m) => m.text?.trim()).slice(0, 5);
  if (mems.length) {
    lines.push("## Lessons from prior runs on this project");
    for (const m of mems) lines.push(`- ${m.text.trim()}`);
  }
  return lines.join("\n");
}

// Durable, non-blocking retain: hand off to MEMORY_QUEUE. Wrapped so a queue
// hiccup can never fail the run step that calls it.
export async function enqueueMemoryRetain(env: Env, msg: MemoryRetainMessage): Promise<void> {
  try {
    await env.MEMORY_QUEUE.send(msg);
  } catch {
    /* best-effort: a lost retain must not fail the run */
  }
}
