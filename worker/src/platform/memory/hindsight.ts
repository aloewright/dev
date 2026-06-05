/* AGPL-3.0-or-later */
// Thin Workers-fetch client for a self-hosted Hindsight server. No Node deps, no
// npm SDK — we need full control of the CF Access + tenant headers and a tight
// timeout on the run hot path. REST contract per hindsight.vectorize.io/api-reference.

import type {
  MemoryProvider,
  RetainInput,
  RetainResult,
  RecallInput,
  RecallResult,
  ReflectInput,
  ReflectResult,
  MentalModelResult,
  BankKey,
} from "./index";

const TENANT = "default"; // Hindsight tenant path segment for the single-tenant API-key extension
const DEFAULT_TIMEOUT_MS = 8_000;
const RECALL_TIMEOUT_MS = 4_000; // recall is on the run hot path — fail fast
const STANDING_MODEL = "project-playbook";

export interface HindsightConfig {
  baseUrl: string;
  apiKey?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export class HindsightMemoryProvider implements MemoryProvider {
  constructor(private readonly cfg: HindsightConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h["authorization"] = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.cfAccessClientId) h["CF-Access-Client-Id"] = this.cfg.cfAccessClientId;
    if (this.cfg.cfAccessClientSecret) h["CF-Access-Client-Secret"] = this.cfg.cfAccessClientSecret;
    return h;
  }

  private bankPath(bank: BankKey, suffix = ""): string {
    return `/v1/${TENANT}/banks/${encodeURIComponent(bank)}${suffix}`;
  }

  private async call<T>(
    path: string,
    method: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init: RequestInit = { method, headers: this.headers(), signal: ctrl.signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(new URL(path, this.cfg.baseUrl).toString(), init);
      if (!res.ok) throw new Error(`hindsight ${method} ${path} -> HTTP ${res.status}`);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(t);
    }
  }

  async retain(input: RetainInput): Promise<RetainResult> {
    try {
      const r = await this.call<{ operation_id?: string | null }>(
        this.bankPath(input.bank, "/memories"),
        "POST",
        {
          items: [
            {
              content: input.content,
              context: serializeContext(input.context),
              tags: input.tags ?? [],
              timestamp: new Date(input.ts ?? Date.now()).toISOString(),
            },
          ],
          async: false,
        },
        DEFAULT_TIMEOUT_MS,
      );
      return { ok: true, hindsightId: r.operation_id ?? null };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    try {
      const r = await this.call<{ results?: Array<{ id?: string; text?: string; type?: string }> }>(
        this.bankPath(input.bank, "/memories/recall"),
        "POST",
        { query: input.query, budget: "mid", max_tokens: 2048 },
        RECALL_TIMEOUT_MS,
      );
      const memories = (r.results ?? [])
        .filter((x) => x.text)
        .slice(0, input.limit ?? 5)
        .map((x) => ({ id: x.id, text: x.text as string, type: x.type }));
      return { ok: true, memories };
    } catch (e) {
      // Fail soft: empty context, run proceeds.
      return { ok: true, memories: [], error: errMsg(e) };
    }
  }

  async reflect(input: ReflectInput): Promise<ReflectResult> {
    try {
      const r = await this.call<{ text?: string }>(
        this.bankPath(input.bank, "/reflect"),
        "POST",
        { query: input.query, budget: "low" },
        DEFAULT_TIMEOUT_MS,
      );
      return { ok: true, text: r.text ?? "" };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  async mentalModel(bank: BankKey): Promise<MentalModelResult | null> {
    try {
      const r = await this.call<{
        mental_models?: Array<{ name?: string; content?: string }>;
      }>(this.bankPath(bank, "/mental-models?detail=content"), "GET", undefined, RECALL_TIMEOUT_MS);
      const list = Array.isArray(r.mental_models) ? r.mental_models : [];
      const m = list.find((x) => x.content?.trim());
      return m?.content ? { content: m.content, name: m.name } : null;
    } catch {
      return null;
    }
  }

  async ensureBank(bank: BankKey): Promise<void> {
    // Idempotent: set bank config, then create the standing playbook mental model.
    // Callers should still guard with a KV flag to avoid the round-trips per retain.
    try {
      await this.call(
        this.bankPath(bank),
        "PUT",
        {
          retain_mission:
            "Capture what was attempted in each coding run on this project and whether it succeeded, including errors, test outcomes, and PR results.",
          reflect_mission:
            "Explain what approaches succeed or fail on this project and why, so future runs avoid known pitfalls.",
          enable_observations: true,
        },
        DEFAULT_TIMEOUT_MS,
      );
      await this.call(
        this.bankPath(bank, "/mental-models"),
        "POST",
        {
          id: STANDING_MODEL,
          name: "Project playbook",
          source_query:
            "What approaches succeed or fail on this project, and what should future runs know before starting?",
          trigger: { refresh_after_consolidation: true },
        },
        DEFAULT_TIMEOUT_MS,
      );
    } catch {
      /* best-effort setup; recall/retain still work without it */
    }
  }

  async health() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      const res = await fetch(new URL("/health", this.cfg.baseUrl).toString(), {
        headers: this.headers(),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }
}

function serializeContext(ctx: Record<string, unknown>): string {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join(" | ");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
