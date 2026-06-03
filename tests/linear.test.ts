/* AGPL-3.0-or-later */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearIssue, resolveProjectTeam } from "../worker/src/platform/linear";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGraphql(data: unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  return calls;
}

describe("resolveProjectTeam", () => {
  it("returns the first team id for a project", async () => {
    const calls = mockGraphql({ project: { teams: { nodes: [{ id: "team_1" }] } } });
    const teamId = await resolveProjectTeam("tok", "proj_1");
    expect(teamId).toBe("team_1");
    expect(calls[0]?.variables).toEqual({ id: "proj_1" });
  });

  it("returns null when the project has no team", async () => {
    mockGraphql({ project: { teams: { nodes: [] } } });
    expect(await resolveProjectTeam("tok", "proj_1")).toBeNull();
  });
});

describe("createLinearIssue", () => {
  it("creates an issue and returns its identifier + url", async () => {
    const calls = mockGraphql({
      issueCreate: {
        success: true,
        issue: { id: "iss_1", identifier: "ENG-12", url: "https://linear.app/x/ENG-12", title: "Do it" },
      },
    });
    const created = await createLinearIssue("tok", {
      teamId: "team_1",
      projectId: "proj_1",
      title: "Do it",
      description: "body",
      priority: 2,
    });
    expect(created).toEqual({
      id: "iss_1",
      identifier: "ENG-12",
      url: "https://linear.app/x/ENG-12",
      title: "Do it",
    });
    expect(calls[0]?.variables).toMatchObject({
      teamId: "team_1",
      projectId: "proj_1",
      title: "Do it",
      description: "body",
      priority: 2,
    });
  });

  it("returns null when creation does not succeed", async () => {
    mockGraphql({ issueCreate: { success: false, issue: null } });
    const created = await createLinearIssue("tok", {
      teamId: "team_1",
      projectId: "proj_1",
      title: "x",
      description: "",
      priority: 3,
    });
    expect(created).toBeNull();
  });
});
