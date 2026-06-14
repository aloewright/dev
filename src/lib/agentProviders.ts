/* AGPL-3.0-or-later */

export type AgentProvider = "claude-code" | "codex" | "cloudflare";

export const AGENT_PROVIDER_OPTIONS: Array<{ label: string; value: AgentProvider }> = [
  { label: "Claude", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Cloudflare", value: "cloudflare" },
];

export const AGENT_PROVIDER_SUMMARY: Record<AgentProvider, string> = {
  "claude-code": "Claude Code with Codex failover",
  codex: "Codex CLI on GPT-5.5",
  cloudflare: "Codex CLI on Workers AI",
};
