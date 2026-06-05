/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { classifyAgentFailure } from "./agent-failure.mjs";

describe("classifyAgentFailure", () => {
  it("flags Claude session/usage rate limits", () => {
    expect(classifyAgentFailure(1, "you've hit your usage limit", "").error).toBe("claude_rate_limited");
    expect(classifyAgentFailure(1, "Claude usage limit reached · resets 3:50am (UTC)", "").error).toBe("claude_rate_limited");
  });
  it("flags SIGKILL/timeout as agent_timeout", () => {
    expect(classifyAgentFailure(143, "", "").error).toBe("agent_timeout");
  });
  it("flags genuine auth failures", () => {
    expect(classifyAgentFailure(1, "", "API Error: 401 Invalid bearer token").error).toBe("claude_auth_failed");
    expect(classifyAgentFailure(1, "Not logged in · Please run /login", "").error).toBe("claude_auth_failed");
  });
  it("falls back to agent_error for unknown non-zero exits", () => {
    expect(classifyAgentFailure(1, "some other crash", "").error).toBe("agent_error");
  });
  it("parses a UTC reset time into retryAfter (ISO) for rate limits", () => {
    const r = classifyAgentFailure(1, "resets 3:50am (UTC)", "");
    expect(r.error).toBe("claude_rate_limited");
    expect(typeof r.retryAfter === "string" || r.retryAfter === null).toBe(true);
  });
});
