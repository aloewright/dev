/* AGPL-3.0-or-later */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NoopMemoryProvider,
  bankKeyFor,
  formatRecallForPrompt,
  getMemoryProvider,
} from "../worker/src/platform/memory";
import { HindsightMemoryProvider } from "../worker/src/platform/memory/hindsight";
import type { Env } from "../worker/src/env";

const enabledEnv = {
  MEMORY_ENABLED: "true",
  HINDSIGHT_BASE_URL: "https://hindsight.example",
  HINDSIGHT_API_KEY: "k",
} as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("bankKeyFor (stable identity)", () => {
  it("keys on the immutable user id, not the slug", () => {
    // Two different auth slugs that resolved to the same app_users.id -> same bank.
    expect(bankKeyFor("user_abc", "proj_1")).toBe(bankKeyFor("user_abc", "proj_1"));
  });
  it("is stable across project rename (same projectId)", () => {
    expect(bankKeyFor("user_abc", "proj_1")).toBe("u:user_abc:p:proj_1");
  });
  it("falls back to a default bank with no project", () => {
    expect(bankKeyFor("user_abc", null)).toBe("u:user_abc:default");
    expect(bankKeyFor("user_abc")).toBe("u:user_abc:default");
  });
  it("isolates different users", () => {
    expect(bankKeyFor("user_a", "p")).not.toBe(bankKeyFor("user_b", "p"));
  });
});

describe("getMemoryProvider factory", () => {
  it("returns Noop when disabled", () => {
    expect(getMemoryProvider({ MEMORY_ENABLED: "false" } as unknown as Env)).toBeInstanceOf(NoopMemoryProvider);
  });
  it("returns Noop when base url missing", () => {
    expect(getMemoryProvider({ MEMORY_ENABLED: "true" } as unknown as Env)).toBeInstanceOf(NoopMemoryProvider);
  });
  it("returns Hindsight provider when configured", () => {
    expect(getMemoryProvider(enabledEnv)).toBeInstanceOf(HindsightMemoryProvider);
  });
});

describe("NoopMemoryProvider", () => {
  it("recall looks like 'no memories yet', retain reports disabled", async () => {
    const p = new NoopMemoryProvider();
    expect(await p.recall({ bank: "b", query: "q" })).toEqual({ ok: true, memories: [] });
    expect((await p.retain({ bank: "b", content: "c", context: {} })).ok).toBe(false);
  });
});

describe("formatRecallForPrompt", () => {
  it("renders playbook + memories and is empty when nothing", () => {
    expect(formatRecallForPrompt({ ok: true, memories: [] }, null)).toBe("");
    const out = formatRecallForPrompt(
      { ok: true, memories: [{ text: "PR #42 passed tests" }] },
      { content: "Prefer small diffs." },
    );
    expect(out).toContain("playbook");
    expect(out).toContain("Prefer small diffs.");
    expect(out).toContain("PR #42 passed tests");
  });
});

describe("graceful degradation — Hindsight unreachable", () => {
  const p = new HindsightMemoryProvider({ baseUrl: "https://hindsight.example", apiKey: "k" });

  it("recall fails soft to empty when fetch rejects (run path unaffected)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const r = await p.recall({ bank: "b", query: "q" });
    expect(r.ok).toBe(true);
    expect(r.memories).toEqual([]);
  });

  it("retain returns ok:false without throwing when the server errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const r = await p.retain({ bank: "b", content: "c", context: { runId: "run_1" } });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("retain succeeds and surfaces the operation id on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ success: true, operation_id: "op_1" })),
    );
    const r = await p.retain({ bank: "b", content: "c", context: { runId: "run_1" } });
    expect(r.ok).toBe(true);
    expect(r.hindsightId).toBe("op_1");
  });
});
