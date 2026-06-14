/* AGPL-3.0-or-later */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexGatewayEnv,
  DEFAULT_CLOUDFLARE_GATEWAY_MODEL,
  DEFAULT_CODEX_GATEWAY_MODEL,
  writeCodexGatewayConfig,
} from "./codex-gateway.mjs";

describe("codex gateway config", () => {
  it("writes a gateway Responses config without persisting the token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fly-dev-codex-test-"));
    try {
      const written = writeCodexGatewayConfig(
        { runId: "run:test/1" },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
          token: "secret-token",
          gatewayId: "x",
          model: "openai/gpt-5.5",
        },
        root,
      );

      expect(written?.model).toBe(DEFAULT_CODEX_GATEWAY_MODEL);
      const config = await readFile(path.join(written.codexHome, "config.toml"), "utf8");
      expect(config).toContain('model = "openai/gpt-5.5"');
      expect(config).toContain('base_url = "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('"cf-aig-gateway-id" = "CF_AIG_GATEWAY_ID"');
      expect(config).not.toContain("secret-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the environment Codex needs to authenticate through the gateway", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fly-dev-codex-test-"));
    try {
      const env = buildCodexGatewayEnv(
        { runId: "run_ok" },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
          token: "secret-token",
          gatewayId: "x",
          model: "openai/gpt-5.5",
        },
        root,
      );

      expect(env).toMatchObject({
        CF_AIG_TOKEN: "secret-token",
        CF_AIG_GATEWAY_ID: "x",
      });
      expect(env?.CODEX_HOME).toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can write the Workers AI model used by the Cloudflare option", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fly-dev-codex-test-"));
    try {
      const written = writeCodexGatewayConfig(
        { runId: "run_cloudflare" },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
          token: "secret-token",
          gatewayId: "x",
          model: DEFAULT_CLOUDFLARE_GATEWAY_MODEL,
        },
        root,
      );

      const config = await readFile(path.join(written.codexHome, "config.toml"), "utf8");
      expect(config).toContain('model = "@cf/openai/gpt-oss-120b"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).not.toContain("secret-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
