/* AGPL-3.0-or-later */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMergedPrForIssue } from "../worker/src/platform/github";
import type { Env } from "../worker/src/env";

// Uses GITHUB_PAT so getInstallationToken returns null and only one fetch is made
const mockEnv = {
  GITHUB_APP_ID: undefined,
  GITHUB_APP_PRIVATE_KEY: undefined,
  GITHUB_PAT: "ghp_test_token_for_tests",
} as unknown as Env;

describe("findMergedPrForIssue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when a merged PR references the issue identifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ total_count: 1, items: [{ number: 42 }] }),
      }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-42");

    expect(result).toBe(true);
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("FLY-42");
    expect(url).toContain("is%3Amerged");
  });

  it("returns false when no merged PRs match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-99");

    expect(result).toBe(false);
  });

  it("returns null (unknown) when the GitHub API returns an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-1");

    // A transient API failure is "unknown", not a definite "not merged".
    expect(result).toBe(null);
  });

  it("returns null (unknown) when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await findMergedPrForIssue(mockEnv, "acme", "myrepo", "FLY-1");

    expect(result).toBe(null);
  });

  it("returns null (unknown) when no token is available", async () => {
    const noTokenEnv = {
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_PAT: undefined,
    } as unknown as Env;

    const result = await findMergedPrForIssue(noTokenEnv, "acme", "myrepo", "FLY-1");

    expect(result).toBe(null);
  });
});
