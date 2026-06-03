/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { reclaimUserData } from "../worker/src/platform/data";

// Minimal recording fake of the D1 surface reclaimUserData uses
// (env.DB.prepare(sql).bind(...).run() -> { meta: { changes } }).
function fakeEnv(changesByTable: Record<string, number>) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() {
              calls.push({ sql, binds });
              const table = /(?:UPDATE|DELETE FROM)\s+(\w+)/.exec(sql)?.[1] ?? "";
              return { meta: { changes: changesByTable[table] ?? 0 } };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

describe("reclaimUserData", () => {
  it("re-points user-scoped tables and drops legacy connections", async () => {
    const { env, calls } = fakeEnv({
      github_repos: 274,
      runs: 5,
      usage_events: 12,
      agent_memories: 0,
      account_connections: 4,
    });

    const result = await reclaimUserData(env, "user_canon");

    expect(result).toEqual({
      repos: 274,
      runs: 5,
      usage: 12,
      memories: 0,
      connectionsDropped: 4,
    });
    // every statement targets the canonical user and excludes it from the WHERE
    for (const call of calls) {
      expect(call.binds).toContain("user_canon");
    }
    expect(calls.some((c) => /UPDATE github_repos/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM account_connections/.test(c.sql))).toBe(true);
  });

  it("is a no-op on re-run (nothing left to fold)", async () => {
    const { env } = fakeEnv({});
    const result = await reclaimUserData(env, "user_canon");
    expect(result).toEqual({
      repos: 0,
      runs: 0,
      usage: 0,
      memories: 0,
      connectionsDropped: 0,
    });
  });
});
