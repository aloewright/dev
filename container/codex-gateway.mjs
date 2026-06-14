/* AGPL-3.0-or-later */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CODEX_GATEWAY_MODEL = "openai/gpt-5.5";
export const DEFAULT_CLOUDFLARE_GATEWAY_MODEL = "@cf/openai/gpt-oss-120b";
export const CODEX_GATEWAY_PROVIDER = "cloudflare_gateway";

const CODEX_HOME_ROOT = "/tmp/fly-dev-codex";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function safePathSegment(value) {
  return String(value || "run").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function writeCodexGatewayConfig(job, gateway, root = CODEX_HOME_ROOT) {
  if (!gateway?.url) return null;

  const model = gateway.model || DEFAULT_CODEX_GATEWAY_MODEL;
  const codexHome = path.join(root, safePathSegment(job?.runId));
  mkdirSync(codexHome, { recursive: true });

  // Codex 0.139+ requires the Responses API. Cloudflare dynamic routes are still
  // chat-completions-only today, so this provider uses AI Gateway's REST
  // Responses endpoint. Swap the model back to dynamic/* if Cloudflare adds
  // Responses support for dynamic routes.
  const config = [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(CODEX_GATEWAY_PROVIDER)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    `[model_providers.${CODEX_GATEWAY_PROVIDER}]`,
    `name = "Cloudflare AI Gateway"`,
    `base_url = ${tomlString(gateway.url)}`,
    `env_key = "CF_AIG_TOKEN"`,
    `wire_api = "responses"`,
    `env_http_headers = { "cf-aig-gateway-id" = "CF_AIG_GATEWAY_ID" }`,
    "",
  ].join("\n");

  writeFileSync(path.join(codexHome, "config.toml"), config, "utf8");
  return { codexHome, model };
}

export function buildCodexGatewayEnv(job, gateway, root = CODEX_HOME_ROOT) {
  const written = writeCodexGatewayConfig(job, gateway, root);
  if (!written) return null;

  const token = String(gateway.token || "");
  return {
    CODEX_HOME: written.codexHome,
    CF_AIG_TOKEN: token,
    CF_AIG_GATEWAY_ID: String(gateway.gatewayId || "x"),
  };
}
