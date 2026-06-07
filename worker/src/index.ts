/* AGPL-3.0-or-later */
import { Agent, routeAgentRequest } from "agents";
import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ContainerRunResult, CurrentUser, Env, MemoryRetainMessage, RunWorkflowParams, WorkQueueMessage } from "./env";
import {
  getMemoryProvider,
  bankKeyFor,
  formatRecallForPrompt,
  enqueueMemoryRetain,
} from "./platform/memory";
import { summarizeRunForMemory } from "./platform/run-summary";
import { getCurrentUser, requireUser, verifyInternalRequest } from "./platform/auth-session";
import { hubLoginRedirect } from "./platform/fly-auth";
import {
  all,
  ensureUser,
  first,
  getOverview,
  getProjects,
  getRuns,
  id,
  recordRunEvent,
  recordUsage,
  reclaimUserData,
  getActiveRunCount,
  bumpHeartbeat,
  runSql,
} from "./platform/data";
import {
  autoMapProjects,
  backfillGithubRepos,
  backfillLinearProjects,
  clearProjectMapping,
  createOAuthConnectUrl,
  getDecryptedToken,
  getValidLinearToken,
  getLinearProjectIssues,
  handleOAuthCallback,
  setProjectMapping,
  storeWebhook,
  syncLinearProjectFromPayload,
  verifyWebhook,
  type OAuthProvider,
} from "./platform/integrations";
import {
  approveRun,
  cancelRun,
  retryTaskRun,
  nextDispatchSeq,
  createTaskRun,
  enqueueRun,
  createTemplateApp,
  markRunCompleted,
  markRunFailed,
  markRunStarting,
  markRunReady,
  prepareRunCredentials,
  resolveRunPlan,
  startRunWorkflow,
  type CreateTaskPayload,
} from "./platform/orchestration";
import { writeBackToLinear } from "./platform/linear";
import { mergeWhenGreen, deleteRepository, renameRepository } from "./platform/github";
import { continueProject } from "./platform/continue";
import { runGoal, listGoals } from "./platform/goal";
import { getCore, getCoreResponse, saveCore, buildCorePreamble } from "./platform/core";
import { listWorkflows, saveWorkflow, deleteWorkflow } from "./platform/workflows";
import { ingestKnowledge } from "./platform/knowledge";
import { generateTextResponse } from "./platform/ai";
import {
  isRetryableError,
  isCapacityError,
  shouldRetryNoChanges,
  reapKind,
  reapBudgetField,
  reapBudgetCap,
  MAX_STUCK_REDISPATCH,
} from "./platform/reaper-policy";
import { dispatchFromGitHubWebhook, dispatchFromLinearWebhook } from "./platform/webhook-dispatch";
import { redactSecrets } from "./platform/crypto";

const app = new Hono<{ Bindings: Env; Variables: { user: CurrentUser | null } }>();

app.use("*", async (c, next) => {
  // With run_worker_first, every static sub-resource also hits this middleware.
  // Skip the hub get-session round-trip for non-navigation sub-resources
  // (script/style/font/image/etc) and the public assets path — they don't need a
  // user, and a fetch-per-asset would hammer the hub. Page navigations, API, and
  // agent calls still resolve the user.
  const dest = c.req.header("sec-fetch-dest");
  const isStaticSubresource =
    dest != null && dest !== "document" && dest !== "empty";
  if (isStaticSubresource) {
    c.set("user", null);
    return next();
  }
  const user = await getCurrentUser(c.req.raw, c.env);
  c.set("user", user);
  await next();
});

app.get("/api/health", async (c) => {
  // Opt-in live reachability probe for the memory engine (kept off the default path
  // so the cheap health check stays cheap): /api/health?probe=memory
  let memoryProbe: { configured: boolean; reachable?: boolean; detail?: string } | undefined;
  if (c.req.query("probe") === "memory") {
    const configured = c.env.MEMORY_ENABLED === "true" && Boolean(c.env.HINDSIGHT_BASE_URL);
    const h = configured ? await getMemoryProvider(c.env).health() : { ok: false, detail: "disabled" };
    memoryProbe = { configured, reachable: h.ok, detail: h.detail };
  }
  return c.json({
    ok: true,
    service: "fly-dev",
    url: c.env.APP_URL,
    bindings: {
      d1: Boolean(c.env.DB),
      r2: Boolean(c.env.ARTIFACTS),
      kv: Boolean(c.env.CACHE),
      queue: Boolean(c.env.WORK_QUEUE),
      memoryQueue: Boolean(c.env.MEMORY_QUEUE),
      workflow: Boolean(c.env.RUN_WORKFLOW),
      userWorkers: Boolean(c.env.USER_WORKERS),
      aiGateway: Boolean(c.env.AI),
      browser: Boolean(c.env.MYBROWSER),
      memory: c.env.MEMORY_ENABLED === "true" && Boolean(c.env.HINDSIGHT_BASE_URL),
    },
    ...(memoryProbe ? { memory: memoryProbe } : {}),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/me", async (c) => {
  return c.json(c.get("user"));
});

app.get("/api/overview", async (c) => {
  const user = c.get("user");
  const overview = await getOverview(c.env, user);
  // Self-heal: if an authed user has zero repos but a sync is possible (PAT set or
  // GitHub connected), kick off a one-shot backfill in the background. Guarded by a
  // per-user KV flag so it runs at most once an hour and never blocks the response.
  // Without this, an identity change (see the repos-fix spec) leaves repos empty
  // with no obvious recovery. Repos appear on the next refresh.
  if (user && overview.repos.length === 0) {
    const githubConnected = overview.connections.some(
      (conn) => conn.provider === "github" && conn.status === "connected",
    );
    if (c.env.GITHUB_PAT || githubConnected) {
      const flagKey = `repos-autosync:${user.id}`;
      const alreadyTried = await c.env.CACHE.get(flagKey);
      if (!alreadyTried) {
        await c.env.CACHE.put(flagKey, "1", { expirationTtl: 3600 });
        c.executionCtx.waitUntil(backfillGithubRepos(c.env, user.id).catch(() => undefined));
      }
    }
  }
  return c.json(overview);
});

app.get("/api/usage", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }
  return c.json((await getOverview(c.env, user)).usage);
});

app.get("/api/projects", async (c) => {
  return c.json({ projects: await getProjects(c.env) });
});

// AI Gateway smoke test endpoints.
// `?route=binding` (default) uses the sanctioned working pattern from
// ~/.claude/CLAUDE.md: env.AI.run("@cf/<model>", ..., { gateway: { id } }).
// `?route=dynamic` tries `dynamic/text_gen` to re-confirm the upstream
// Worker-side bug and detect when it's fixed.
const AI_TEST_MODEL = "@cf/openai/gpt-oss-120b";
const AI_MAX_TOKENS_CAP = 2048;

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function clampTokens(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(1, Math.trunc(n)), AI_MAX_TOKENS_CAP);
}

async function runAi(
  env: Env,
  route: "binding" | "dynamic",
  messages: ChatMessage[],
  maxTokens: number,
) {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  const model = route === "dynamic" ? "dynamic/text_gen" : AI_TEST_MODEL;
  const raw = await (env.AI as unknown as {
    run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
  }).run(model, { messages, max_tokens: maxTokens }, { gateway: { id: gatewayId } });
  return { gatewayId, model, raw };
}

function summarizeAiResponse(raw: unknown): {
  content: string | null;
  finishReason: string | null;
} {
  const r = raw as {
    choices?: Array<{
      message?: { content?: string | null };
      finish_reason?: string | null;
    }>;
  };
  const choice = r?.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    finishReason: choice?.finish_reason ?? null,
  };
}

// Reasoning models (e.g. gpt-oss-120b) spend tokens on `reasoning_content`
// before emitting `content`. If the budget runs out mid-reasoning, the gateway
// call still succeeds (200) but `content` is null. Signal that to the caller
// as ok:false with a 200 (transport succeeded) so it's distinguishable from a
// thrown gateway error (500).
function aiResponseEnvelope(args: {
  route: "binding" | "dynamic";
  model: string;
  gatewayId: string;
  ms: number;
  maxTokens: number;
  raw: unknown;
}) {
  const { content, finishReason } = summarizeAiResponse(args.raw);
  const incomplete = (content === null || content === "") && finishReason === "length";
  return {
    ok: !incomplete,
    route: args.route,
    model: args.model,
    gatewayId: args.gatewayId,
    ms: args.ms,
    content,
    finishReason,
    ...(incomplete
      ? {
          error: `Model returned no content (finish_reason=length). maxTokens=${args.maxTokens} was likely exhausted on reasoning_content. Try increasing maxTokens.`,
        }
      : {}),
  };
}

async function streamAi(
  env: Env,
  route: "binding" | "dynamic",
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ReadableStream<Uint8Array>> {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  const model = route === "dynamic" ? "dynamic/text_gen" : AI_TEST_MODEL;
  return (await (
    env.AI as unknown as {
      run: (
        m: string,
        i: unknown,
        o: { gateway: { id: string } },
      ) => Promise<ReadableStream<Uint8Array>>;
    }
  ).run(
    model,
    { messages, max_tokens: maxTokens, stream: true },
    { gateway: { id: gatewayId } },
  )) as ReadableStream<Uint8Array>;
}

// Different models stream their visible output in different delta fields:
//   gpt-oss-120b (binding route): `delta.reasoning_content` (internal trace,
//     useful for debugging) then `delta.content` (final answer).
//   gemma via dynamic route:      `delta.reasoning` is the *only* output
//     channel — there's no separate `delta.content`.
// Pick whichever non-null text channel a chunk carries and tag it with `kind`
// so the consumer can filter (`kind === "content"` for clean OpenAI output,
// include "reasoning" if you want everything).
function extractDelta(delta: unknown): {
  text: string | null;
  kind: "content" | "reasoning" | null;
} {
  if (!delta || typeof delta !== "object") return { text: null, kind: null };
  const d = delta as Record<string, unknown>;
  if (typeof d.content === "string") return { text: d.content, kind: "content" };
  if (typeof d.reasoning === "string") return { text: d.reasoning, kind: "reasoning" };
  if (typeof d.reasoning_content === "string") {
    return { text: d.reasoning_content, kind: "reasoning" };
  }
  return { text: null, kind: null };
}

// Re-wrap OpenAI-compatible SSE chunks (`data: {...}\n\ndata: [DONE]\n\n`)
// as line-delimited JSON: `{"delta":"...","kind":"content","finishReason":null,"done":false}\n`
// per chunk, terminated by `{"done":true}\n`. `kind` distinguishes
// user-visible content from internal reasoning traces.
function sseToNdjson(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sawDone = false;
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice("data: ".length).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
          continue;
        }
        try {
          const evt = JSON.parse(payload) as {
            choices?: Array<{ delta?: unknown; finish_reason?: string | null }>;
          };
          const { text, kind } = extractDelta(evt.choices?.[0]?.delta);
          const finishReason = evt.choices?.[0]?.finish_reason ?? null;
          if (text !== null || finishReason !== null) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ delta: text, kind, finishReason, done: false }) + "\n",
              ),
            );
          }
        } catch {
          // skip malformed payload
        }
      }
    },
    flush(controller) {
      if (!sawDone) {
        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
      }
    },
  });
}

function pickStreamFormat(c: {
  req: { header: (n: string) => string | undefined; query: (k: string) => string | undefined };
}): "sse" | "ndjson" {
  const explicit = c.req.query("format");
  if (explicit === "ndjson") return "ndjson";
  if (explicit === "sse") return "sse";
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  if (accept.includes("application/x-ndjson") || accept.includes("application/json")) {
    return "ndjson";
  }
  return "sse";
}

async function respondWithStream(
  env: Env,
  format: "sse" | "ndjson",
  route: "binding" | "dynamic",
  messages: ChatMessage[],
  maxTokens: number,
): Promise<Response> {
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamAi(env, route, messages, maxTokens);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        route,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
  const body = format === "ndjson" ? upstream.pipeThrough(sseToNdjson()) : upstream;
  const headers: Record<string, string> = {
    "cache-control": "no-cache",
    "content-type":
      format === "ndjson"
        ? "application/x-ndjson; charset=utf-8"
        : "text/event-stream; charset=utf-8",
  };
  if (format === "sse") headers["x-content-type-options"] = "nosniff";
  return new Response(body, { headers });
}

app.get("/api/ai/stream", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const route = c.req.query("route") === "dynamic" ? "dynamic" : "binding";
  const maxTokensRaw = Number.parseInt(c.req.query("maxTokens") ?? "", 10);
  const maxTokens = clampTokens(Number.isNaN(maxTokensRaw) ? undefined : maxTokensRaw, 128);
  const prompt = c.req.query("prompt") ?? "Say hello in one short sentence.";
  return respondWithStream(
    c.env,
    pickStreamFormat(c),
    route,
    [{ role: "user", content: prompt }],
    maxTokens,
  );
});

app.post("/api/ai/stream", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = await c.req
    .json<{
      prompt?: string;
      messages?: ChatMessage[];
      route?: "binding" | "dynamic";
      maxTokens?: number;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const route = body.route === "dynamic" ? "dynamic" : "binding";
  const maxTokens = clampTokens(body.maxTokens, 256);
  const messages =
    body.messages ?? (body.prompt ? [{ role: "user" as const, content: body.prompt }] : null);
  if (!messages || messages.length === 0) {
    return c.json({ error: "Provide `prompt` (string) or `messages` (array)" }, 400);
  }
  return respondWithStream(c.env, pickStreamFormat(c), route, messages, maxTokens);
});

app.get("/api/ai/ping", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const route = c.req.query("route") === "dynamic" ? "dynamic" : "binding";
  const maxTokens = 64;
  const startedAt = Date.now();
  try {
    const { gatewayId, model, raw } = await runAi(
      c.env,
      route,
      [
        { role: "system", content: "Reply with exactly the single word: pong" },
        { role: "user", content: "ping" },
      ],
      maxTokens,
    );
    return c.json(
      aiResponseEnvelope({
        route,
        model,
        gatewayId,
        ms: Date.now() - startedAt,
        maxTokens,
        raw,
      }),
    );
  } catch (err) {
    return c.json(
      {
        ok: false,
        route,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.post("/api/ai/chat", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = await c.req
    .json<{
      prompt?: string;
      messages?: ChatMessage[];
      route?: "binding" | "dynamic";
      maxTokens?: number;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const route = body.route === "dynamic" ? "dynamic" : "binding";
  const maxTokens = clampTokens(body.maxTokens, 256);
  const messages =
    body.messages ?? (body.prompt ? [{ role: "user" as const, content: body.prompt }] : null);
  if (!messages || messages.length === 0) {
    return c.json({ error: "Provide `prompt` (string) or `messages` (array)" }, 400);
  }
  const startedAt = Date.now();
  try {
    const { gatewayId, model, raw } = await runAi(c.env, route, messages, maxTokens);
    return c.json(
      aiResponseEnvelope({
        route,
        model,
        gatewayId,
        ms: Date.now() - startedAt,
        maxTokens,
        raw,
      }),
    );
  } catch (err) {
    return c.json(
      {
        ok: false,
        route,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.get("/api/projects/:id/runs", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json({ runs: await getRuns(c.env, user.id, c.req.param("id")) });
});

// Open issues for a Linear project, fetched live from the Linear API (nothing
// stored — always current). Used by the dashboard's project drill-down.
app.get("/api/projects/:id/issues", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json(await getLinearProjectIssues(c.env, user.id, c.req.param("id")));
});

// Autonomous "Continue": review the project, plan next steps, create Linear issues,
// and (when CONTINUE_AUTONOMY is on) start runs. See platform/continue.ts.
app.post("/api/projects/:id/continue", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return continueProject(c.env, user, c.req.param("id"));
});

// Auto-map all Linear projects to GitHub repos by name (confident matches become
// active; weaker ones are suggested; manual mappings are preserved).
app.post("/api/projects/auto-map", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json(await autoMapProjects(c.env, user.id));
});

// Manually set or clear a project's GitHub repo mapping.
// Body: { repoId: "gh_<id>" } to set, or { clear: true } to remove.
app.post("/api/projects/:id/mapping", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = (await c.req.json().catch(() => null)) as
    | { repoId?: string; clear?: boolean }
    | null;
  const projectId = c.req.param("id");
  if (body?.clear) {
    return c.json(await clearProjectMapping(c.env, projectId));
  }
  if (!body?.repoId) {
    return c.json({ error: "repoId or clear is required" }, 400);
  }
  const result = await setProjectMapping(c.env, user.id, projectId, body.repoId);
  return c.json(result, result.ok ? 200 : 404);
});

app.get("/api/runs/:id/events", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const run = await first<{ id: string }>(
    c.env,
    "SELECT id FROM runs WHERE id = ? AND user_id = ?",
    [c.req.param("id"), user.id],
  );
  if (!run) {
    return c.json({ error: "Run not found" }, 404);
  }
  const events = await all(
    c.env,
    `SELECT id, event_type AS eventType, message, severity, metadata_json AS metadataJson, created_at AS createdAt
     FROM run_events
     WHERE run_id = ?
     ORDER BY created_at ASC, id ASC`,
    [run.id],
  );
  return c.json({ events });
});

// Server-sent events: live run event stream for the Command Center. Polls D1 by
// id-cursor and pushes new rows; closes on terminal status or after a max lifetime.
app.get("/api/runs/:id/events/stream", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const runId = c.req.param("id");
  const owned = await first<{ id: string }>(
    c.env,
    "SELECT id FROM runs WHERE id = ? AND user_id = ?",
    [runId, user.id],
  );
  if (!owned) return c.json({ error: "Run not found" }, 404);

  const env = c.env;
  const encoder = new TextEncoder();
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  const MAX_LIFETIME_MS = 15 * 60 * 1000;

  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let cursor = 0;
      let lastStatus = "";
      const startedAt = Date.now();
      send("open", { runId });
      while (!cancelled && Date.now() - startedAt < MAX_LIFETIME_MS) {
        try {
          const rows = await all<{ id: number; eventType: string; message: string; severity: string; metadataJson: string; createdAt: string }>(
            env,
            `SELECT id, event_type AS eventType, message, severity, metadata_json AS metadataJson, created_at AS createdAt
               FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
            [runId, cursor],
          );
          for (const row of rows) {
            cursor = row.id;
            send("run_event", row);
          }
          const statusRow = await first<{ status: string }>(env, "SELECT status FROM runs WHERE id = ?", [runId]);
          if (statusRow && statusRow.status !== lastStatus) {
            lastStatus = statusRow.status;
            send("status", { status: lastStatus });
          }
          if (statusRow && TERMINAL.has(statusRow.status)) {
            send("done", { status: statusRow.status });
            break;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
});

app.post("/api/tasks", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return createTaskRun(c.env, user, payload as CreateTaskPayload);
});

// Goal intake: decompose an objective into Linear issues under the chosen project
// and dispatch a run per issue. This is the primary "actionable portal" entrypoint.
app.post("/api/goals", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return runGoal(c.env, user, payload as { objective?: string; linearProjectId?: string });
});

app.get("/api/goals", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return listGoals(c.env, user);
});

// Core: global soul (identity/values/guardrails) + rules, injected into
// decomposition and every run prompt.
app.get("/api/core", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return getCoreResponse(c.env, user);
});

app.put("/api/core", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => ({}));
  return saveCore(c.env, user, payload as { soul?: unknown; rules?: unknown });
});

// Workflows: reusable parameterized goal templates.
app.get("/api/workflows", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return listWorkflows(c.env, user);
});

app.post("/api/workflows", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => ({}));
  return saveWorkflow(c.env, user, payload as Record<string, unknown>);
});

app.delete("/api/workflows/:id", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return deleteWorkflow(c.env, user, c.req.param("id"));
});

// Knowledge base: upload a file (pdf/md/txt/png/jpg) → extract text → retain into
// a Hindsight memory bank (global or a specific project).
app.post("/api/knowledge", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Expected multipart form data" }, 400);
  return ingestKnowledge(c.env, user, form);
});

// Editor /ai slash command: generate text via the AI Gateway.
app.post("/api/ai/generate", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => ({}));
  return generateTextResponse(c.env, user, payload as { prompt?: unknown; context?: unknown });
});

app.post("/api/runs/:id/approve", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return approveRun(c.env, user, c.req.param("id"));
});

app.post("/api/runs/:id/cancel", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return cancelRun(c.env, user, c.req.param("id"));
});

app.post("/api/runs/:id/retry", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return retryTaskRun(c.env, user, c.req.param("id"));
});

app.delete("/api/repos/:id", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const repoId = c.req.param("id");
  const repo = await first<{ owner: string; name: string }>(
    c.env,
    "SELECT owner, name FROM github_repos WHERE id = ? AND user_id = ?",
    [repoId, user.id],
  );
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  // Prefer the classic PAT: the connected "github" account is a GitHub *App* token
  // (user-to-server), which CANNOT delete repositories ("Resource not accessible by
  // integration"). A classic personal access token with the delete_repo scope can.
  const token = c.env.GITHUB_PAT || (await getDecryptedToken(c.env, user.id, "github"));
  if (!token) return c.json({ error: "GitHub connection required" }, 400);

  const result = await deleteRepository(token, repo.owner, repo.name);
  if (!result.ok) {
    // The repo is already gone on GitHub (renamed/deleted elsewhere) — the local cache
    // row is stale. "Deleting" it should just prune the stale row, not error forever.
    if (result.status === 404) {
      await runSql(c.env, "DELETE FROM github_repos WHERE id = ? AND user_id = ?", [repoId, user.id]);
      return c.json({ ok: true, pruned: true });
    }
    // 403: the token can't delete this repo. GitHub Apps can't delete repos at all, and
    // a PAT/OAuth token needs the delete_repo scope + admin on the repo.
    if (result.status === 403) {
      return c.json(
        {
          error: `${result.error} — deleting a repo needs a classic GitHub personal access token with the "delete_repo" scope (set as GITHUB_PAT). The connected GitHub App can't delete repositories; otherwise delete it on github.com.`,
        },
        403,
      );
    }
    return c.json({ error: result.error }, 500);
  }

  await runSql(c.env, "DELETE FROM github_repos WHERE id = ? AND user_id = ?", [repoId, user.id]);
  return c.json({ ok: true });
});

app.patch("/api/repos/:id", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const repoId = c.req.param("id");
  const { name: newName } = (await c.req.json()) as { name: string };
  if (!newName) return c.json({ error: "New name is required" }, 400);

  const repo = await first<{ owner: string; name: string }>(
    c.env,
    "SELECT owner, name FROM github_repos WHERE id = ? AND user_id = ?",
    [repoId, user.id],
  );
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  // Prefer the classic PAT (GitHub App tokens lack repo-admin for rename in many setups).
  const token = c.env.GITHUB_PAT || (await getDecryptedToken(c.env, user.id, "github"));
  if (!token) return c.json({ error: "GitHub connection required" }, 400);

  const result = await renameRepository(token, repo.owner, repo.name, newName);
  if (!result.ok) return c.json({ error: result.error }, 500);

  await runSql(c.env, "UPDATE github_repos SET name = ?, full_name = ? WHERE id = ? AND user_id = ?", [
    result.name!,
    `${repo.owner}/${result.name!}`,
    repoId,
    user.id,
  ]);
  return c.json({ ok: true, name: result.name });
});

// Maintenance: force-stop sandbox containers that outlived their run (orphaned/idle
// instances occupying the few container slots). Auth: the signed-in @fly.pm user.
// A run with no heartbeat for this long is "stalled". Mirrors the reaper's
// `datetime('now','-8 minutes')` stall predicate so the maintenance guard and the
// reaper never disagree about whether a run is healthy.
const RUN_STALL_MS = 8 * 60_000;

// Body: { runIds: string[], force?: boolean }. Destroys the container for each
// `run-<runId>`. `force` bypasses the active-run guard (escape hatch for a run that
// is wedged but still heartbeating — e.g. a hung GitHub call).
app.post("/api/maintenance/stop-containers", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const body = (await c.req.json().catch(() => ({}))) as { runIds?: string[]; force?: boolean };
  const runIds = Array.isArray(body.runIds) ? body.runIds.slice(0, 50) : [];
  const force = body.force === true;
  const ns = c.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
  const results: Array<{ runId: string; ok: boolean; error?: string }> = [];
  for (const runId of runIds) {
    // Safety: never hard-kill a genuinely-active run's container unless force=true.
    // "Active" matches the reaper's stall threshold (RUN_STALL_MS, 8min) so the two
    // never disagree, with started_at as a fallback for a slow-booting `starting` run.
    const run = await first<{ status: string; last_heartbeat_at: string | null; started_at: string | null }>(
      c.env,
      "SELECT status, last_heartbeat_at, started_at FROM runs WHERE id = ?",
      [runId],
    );
    const ts = run?.last_heartbeat_at ?? run?.started_at ?? null;
    const hb = ts ? Date.parse(`${ts.replace(" ", "T")}Z`) : 0;
    const activeHealthy =
      run && (run.status === "running" || run.status === "starting") && hb > Date.now() - RUN_STALL_MS;
    if (activeHealthy && !force) {
      results.push({ runId, ok: false, error: "skipped: run active within stall window (use force to override)" });
      continue;
    }
    // destroy() (SIGKILL) is reliable; stop() (SIGTERM) is a no-op on a process that
    // ignores SIGTERM. Neither can START a container (verified in @cloudflare/containers).
    try {
      await getContainer(ns, `run-${runId}`).destroy();
      results.push({ runId, ok: true });
    } catch (e) {
      results.push({ runId, ok: false, error: String(e) });
    }
  }
  return c.json({ stopped: results.filter((r) => r.ok).length, results });
});

// Browsers navigating to /connect or /callback expect to land somewhere
// usable. If the user isn't signed in (or the OAuth state expired), don't
// dump a raw JSON error into the address bar — bounce them back to the
// dashboard with a banner-friendly query param. Programmatic API callers
// (Accept: application/json) still get the JSON shape.
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

app.get("/api/integrations/:provider/connect", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) {
    if (wantsHtml(c.req.raw)) {
      return c.redirect(`/?signin_required=1&provider=${provider}`, 302);
    }
    return user;
  }
  const result = await createOAuthConnectUrl(provider, c.req.raw, c.env, user);
  if (result.setupRequired || c.req.query("format") === "json") {
    return c.json(result);
  }
  return c.redirect(result.url);
});

app.get("/api/integrations/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }
  const response = await handleOAuthCallback(provider, c.req.raw, c.env);
  // Convert genuine error responses (>=400) into a dashboard banner redirect for
  // browser navigations. handleOAuthCallback signals SUCCESS with a 302 redirect,
  // whose `.ok` is false (ok is 2xx only) — keying off `.ok` mislabeled every
  // successful connect as "oauth_error=unknown". Check the status code instead so
  // the 302 success passes through to /?connected=<provider>.
  if (response.status >= 400 && wantsHtml(c.req.raw)) {
    const body = (await response.clone().json().catch(() => ({ error: "unknown" }))) as {
      error?: string;
    };
    const reason = encodeURIComponent(body.error ?? "oauth_failed");
    return c.redirect(`/?oauth_error=${reason}&provider=${provider}`, 302);
  }
  return response;
});

// Manual backfill. Each provider otherwise only populates via webhooks (Linear)
// or never (GitHub repos), so this pulls the full list from the provider API
// using the connected OAuth token and upserts it. Mirrors what a fresh connect
// does, but on demand.
app.post("/api/integrations/:provider/sync", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const result =
    provider === "linear"
      ? await backfillLinearProjects(c.env, user.id)
      : await backfillGithubRepos(c.env, user.id);
  return c.json(result);
});

app.post("/api/webhooks/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }

  const body = await c.req.text();
  if (body.length > 1_000_000) {
    return c.json({ error: "Payload too large" }, 413);
  }

  // Verify the signature BEFORE persisting anything, so unauthenticated clients
  // cannot write to the database. See SANDBOX_REVIEW.md A7.
  const signatureValid = await verifyWebhook(provider, c.req.raw, c.env, body);
  if (!signatureValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const eventId =
    c.req.header("x-github-delivery") ?? c.req.header("linear-delivery") ?? c.req.header("x-linear-delivery") ?? null;
  const eventType = c.req.header("x-github-event") ?? c.req.header("linear-event") ?? null;

  // Deduplicate retried deliveries; skip dispatch if already seen. See B4.
  const { isNew } = await storeWebhook(c.env, provider, body, true, eventId, eventType);
  if (!isNew) {
    return c.json({ ok: true, duplicate: true });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return c.json({ ok: true, warning: "payload parse failed" });
  }

  if (provider === "linear") {
    await syncLinearProjectFromPayload(c.env, payload);
    await dispatchFromLinearWebhook(c.env, payload);
  } else {
    await dispatchFromGitHubWebhook(c.env, payload);
  }

  return c.json({ ok: true });
});

app.post("/api/templates/apps", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return createTemplateApp(c.env, user, payload);
});

app.get("/api/internal/status", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const overview = await getOverview(c.env, c.get("user"));
  return c.json({
    ok: true,
    activeRuns: overview.recentRuns.filter((run) => ["queued", "running", "waiting_approval"].includes(run.status)).length,
    failedRuns: overview.recentRuns.filter((run) => run.status === "failed").length,
    usage: overview.usage,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/internal/pages-deploy", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { projectName?: string; branch?: string; artifactKey?: string }
    | null;
  if (!body || !body.projectName) {
    return c.json({ error: "projectName is required" }, 400);
  }
  const eventId = id("deploy");
  await c.env.CACHE.put(`pages-deploy:${eventId}`, JSON.stringify(body), { expirationTtl: 86_400 });
  return c.json({
    id: eventId,
    status: "accepted",
    note: "Pages deployment request recorded for the next sandbox-capable run.",
  }, 202);
});

app.post("/api/internal/summon", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // Ensure the synthetic internal user exists (runs.user_id has an FK).
  const localUser =
    c.get("user") ??
    (await ensureUser(c.env, {
      email: null,
      name: "Fly Internal",
      flyUserSlug: "internal",
      authSource: "internal",
    }));
  return createTaskRun(c.env, localUser, payload as CreateTaskPayload);
});

// One-time, idempotent reconciliation of orphaned user-scoped data into a single
// canonical user (see the 2026-06-02 repos-fix spec). HMAC-gated like other
// internal routes.
app.post("/api/internal/reclaim", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as { intoUserId?: string } | null;
  if (!body?.intoUserId) {
    return c.json({ error: "intoUserId is required" }, 400);
  }
  const counts = await reclaimUserData(c.env, body.intoUserId);
  const mapped = await autoMapProjects(c.env, body.intoUserId).catch(() => null);
  return c.json({ ok: true, ...counts, mapped });
});

// Container → worker live event stream. HMAC-gated (same scheme as /api/internal/status).
// Body: { eventType, message, severity?, metadata? }. Writes run_events + bumps heartbeat.
app.post("/api/internal/runs/:id/events", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > 1_000_000) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const runId = c.req.param("id");
  let body: { eventType?: string; message?: string; severity?: string; metadata?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.eventType || typeof body.eventType !== "string") {
    return c.json({ error: "missing_event_type" }, 400);
  }
  await recordRunEvent(
    c.env,
    runId,
    body.eventType,
    typeof body.message === "string" ? body.message.slice(0, 2000) : "",
    body.severity === "error" || body.severity === "warn" ? body.severity : "info",
    body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  );
  await bumpHeartbeat(c.env, runId);
  return c.json({ ok: true });
});

// Sign-out. Login lives entirely on the fly.pm hub (auth.fly.pm), which owns the
// .fly.pm session cookie, so sign-out must happen there. Redirect to the hub's
// /logout, which clears the cookie fleet-wide and bounces back to the login page.
// The SPA's "Sign out" button navigates here. Kept at the legacy path so the
// frontend needs no change this wave.
app.get("/api/access-logout", (c) => {
  const hub = c.env.AUTH_HUB_URL || "https://auth.fly.pm";
  return c.redirect(`${hub}/logout`, 302);
});

app.all("/agents/orchestrator/:flyUserId", async (c) => {
  const flyUserId = c.req.param("flyUserId");
  const stub = c.env.DEV_ORCHESTRATOR.get(c.env.DEV_ORCHESTRATOR.idFromName(flyUserId));
  return stub.fetch(c.req.raw);
});

app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/agents/")) {
    return c.json({ error: "Not found" }, 404);
  }

  // Gate TOP-LEVEL PAGE NAVIGATIONS on the fly.pm universal-login hub: an
  // unauthenticated (or non-@fly.pm) visitor is bounced to auth.fly.pm/login and
  // returned here after signing in. This must run BEFORE serving any asset,
  // because the assets binding serves index.html for "/" directly (which would
  // otherwise leak the app shell). Static sub-resources (JS/CSS/fonts/images)
  // are NOT navigations — they carry Sec-Fetch-Dest: script/style/font/image —
  // so they stay public and the login page's own assets can load.
  const dest = c.req.header("sec-fetch-dest");
  const accept = c.req.header("accept") ?? "";
  const isPageNavigation = dest === "document" || (dest == null && accept.includes("text/html"));
  if (isPageNavigation && !c.get("user")) {
    return c.redirect(hubLoginRedirect(c.req.raw, c.env), 302);
  }

  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) {
    return asset;
  }

  // SPA deep-link fallback (no matching asset) — also a navigation; gate it.
  if (!c.get("user")) {
    return c.redirect(hubLoginRedirect(c.req.raw, c.env), 302);
  }
  const indexUrl = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw));
});

export class DevOrchestratorAgent extends Agent<Env, { lastGoal?: string }> {
  initialState = {};

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const payload = (await request.json()) as { goal?: string; task?: string };
      const goal = redactSecrets((payload.goal ?? payload.task ?? "").trim());
      this.setState({ lastGoal: goal });
      return Response.json({
        ok: true,
        agent: "dev-orchestrator",
        user: this.name,
        goal,
        plan: goal
          ? [
              "Inspect connected Linear project and repository mapping.",
              "Draft or update Linear issues for the goal.",
              "Queue a sandbox run after approval.",
            ]
          : [],
      });
    }

    return Response.json({
      ok: true,
      agent: "dev-orchestrator",
      user: this.name,
      memory: {
        sessionAffinity: this.sessionAffinity,
        lastGoal: this.state.lastGoal ?? null,
      },
      route: url.pathname,
    });
  }
}

export class ProjectConductor extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const projectId = this.ctx.id.name ?? url.searchParams.get("projectId") ?? "unknown";
    if (request.method === "POST") {
      const message = (await request.json()) as WorkQueueMessage;
      await this.ctx.storage.put(`last:${message.runId}`, message);
      return Response.json({ ok: true, projectId, accepted: message });
    }
    const runs = await this.ctx.storage.list({ prefix: "last:" });
    return Response.json({ ok: true, projectId, recentMessages: [...runs.values()] });
  }
}

export class UserWorkerController extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const flyUserId = this.ctx.id.name ?? "unknown";
    if (url.pathname.endsWith("/dispatch") && request.method === "POST") {
      const body = (await request.json()) as { workerName?: string; path?: string };
      if (!body.workerName) {
        return Response.json({ error: "workerName is required" }, { status: 400 });
      }
      const worker = this.env.USER_WORKERS.get(body.workerName, { flyUserId });
      const target = new URL(body.path ?? "/", "https://dev.fly.pm");
      return worker.fetch(new Request(target, { method: "GET" }));
    }
    return Response.json({ ok: true, flyUserId, namespace: "fly-dev-production" });
  }
}

export class SandboxContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  // Must exceed the full run duration (up to the 90-min agent timeout + clone/
  // test/push/PR). At 10m the container slept mid-agent-run and SIGTERM'd Claude
  // (exit 143). Idle containers still sleep — just not during a long agent run.
  sleepAfter = "120m";
  envVars = {
    NODE_ENV: "production",
    FLY_DEV_SANDBOX: "true",
    // interceptHttps presents a MITM cert from /etc/cloudflare/certs.
    // Point every common TLS lib at it so git, curl, node, python, go trust it.
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    REQUESTS_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  };
  entrypoint = ["node", "/app/server.mjs"];
  enableInternet = false;
  // Required: route HTTPS through ContainerProxy. With enableInternet=false +
  // interceptHttps=false (the default), HTTPS traffic has no route and times out
  // even for hosts on allowedHosts. Without this every github.com clone hangs.
  interceptHttps = true;
  // Egress allowlist. Per-run secrets travel in the /run request body, never in
  // envVars (which are baked into the class definition). See SANDBOX_REVIEW.md S4/S6.
  // NOTE: the package-registry hosts below are required by the test gate
  // (npm/pip/go installs). This widens the egress surface — a malicious repo's
  // install scripts run here. Repos depending on registries NOT listed (private
  // registries, arbitrary git deps) will fail to install; flip enableInternet to
  // true only if you accept fully open egress from the sandbox.
  allowedHosts = [
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "api.linear.app",
    "gateway.ai.cloudflare.com",
    // claude-code calls api.anthropic.com directly when authed via the OAuth
    // setup-token (subscription billing); the gateway only proxies API keys.
    "api.anthropic.com",
    "firecrawl-cf.lazee.workers.dev",
    // Package registries for the test gate.
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
    // Worker origin for the live-event callback (POST /api/internal/runs/:id/events).
    "dev.fly.pm",
  ];
  pingEndpoint = "localhost:8080/ready";
}

export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  async run(event: WorkflowEvent<RunWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    if (!payload?.runId || !payload.userId) {
      throw new NonRetryableError("Run workflow requires runId and userId");
    }

    const sandboxId = await step.do("reserve sandbox", async () => {
      const sandboxIdValue = `run-${payload.runId}`;
      await markRunStarting(this.env, payload.runId, sandboxIdValue);
      return sandboxIdValue;
    });

    const plan = await step.do("resolve run plan", async () => {
      return resolveRunPlan(this.env, payload.runId);
    });

    if (!plan || !plan.repo) {
      await step.do("abort: no repository", async () => {
        await markRunFailed(
          this.env,
          payload.runId,
          new Error(plan ? "No repository mapped to this run" : "Run not found"),
        );
      });
      return { runId: payload.runId, sandboxId, status: "failed", reason: "no_repository" };
    }
    const repo = plan.repo;
    const linearIssueId = plan.linearIssueId;

    const startResult = await step.do(
      "start sandbox container",
      async (): Promise<{ requeued?: boolean; exhausted?: boolean }> => {
        const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
        const container = getContainer(containerNamespace, sandboxId);
        try {
          await container.startAndWaitForPorts([8080], {
            instanceGetTimeoutMS: 30_000,
            portReadyTimeoutMS: 60_000,
            waitInterval: 1_000,
          });
        } catch (error) {
          // Transient container-capacity errors (the platform has no free instance up to
          // max_instances) must NOT burn the error budget or strand the run — bounded-
          // requeue them on the stuck budget so the run flows back through the queue when
          // capacity frees. Non-capacity errors keep failing fast.
          if (isCapacityError(String(error))) {
            const row = await first<{ metadata_json: string }>(
              this.env,
              "SELECT metadata_json FROM runs WHERE id = ?",
              [payload.runId],
            );
            let meta: Record<string, unknown> = {};
            try {
              meta = JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>;
            } catch {
              meta = {};
            }
            const used = typeof meta.stuckRedispatch === "number" ? meta.stuckRedispatch : 0;

            if (used >= MAX_STUCK_REDISPATCH) {
              // Out of capacity budget: fail terminally and mark exhausted so the reaper
              // treats it as terminal rather than re-dispatching forever. Do NOT rethrow.
              meta.exhausted = true;
              await markRunFailed(this.env, payload.runId, new Error("capacity_exhausted"));
              await runSql(
                this.env,
                "UPDATE runs SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [JSON.stringify(meta), payload.runId],
              );
              return { requeued: false, exhausted: true };
            }

            // Bounded requeue: bump the stuck budget, flip the run back to queued with a
            // fresh clock, and re-enqueue so a future consumer invocation re-creates the
            // workflow once a container slot is free.
            meta.stuckRedispatch = used + 1;
            const seq = nextDispatchSeq(meta);
            await runSql(
              this.env,
              `UPDATE runs
                 SET status = 'queued', started_at = NULL, last_heartbeat_at = NULL,
                     last_error = NULL, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [JSON.stringify(meta), payload.runId],
            );
            await recordRunEvent(
              this.env,
              payload.runId,
              "container.requeue",
              `No free container slot; bounded-requeue ${used + 1}/${MAX_STUCK_REDISPATCH} (capacity).`,
              "warn",
              { attempt: seq },
            );
            await enqueueRun(this.env, {
              runId: payload.runId,
              userId: payload.userId,
              projectId: payload.projectId,
              action: "start-run",
              attempt: seq,
            });
            return { requeued: true };
          }
          await markRunFailed(this.env, payload.runId, new Error(`container_start_failed: ${String(error)}`));
          throw error;
        }
        await markRunReady(this.env, payload.runId);
        return {};
      },
    );

    // Capacity bounded-requeue (or terminal exhaustion) stops the workflow cleanly here.
    // A fresh workflow is created later by the consumer when a slot frees (requeued), or
    // the run is terminal (exhausted). markRunReady only ran on the success path above.
    if (startResult?.requeued || startResult?.exhausted) {
      return {
        runId: payload.runId,
        sandboxId,
        status: startResult.exhausted ? "failed" : "requeued",
        reason: "capacity",
      };
    }

    // Credentials are resolved and used inside this single step so they are
    // never returned from a step (never persisted in Workflow storage). See S6.
    //
    // The container /run is a LONG (up to AGENT_TIMEOUT_MS = 90min agent + clone/test/
    // push/PR) and NON-IDEMPOTENT call (re-running re-clones, re-runs the agent, and can
    // open a DUPLICATE PR). The Workflows default step timeout is only 10 minutes with
    // automatic retries — that was timing out mid-agent and re-running the whole pipeline
    // (observed: 3x clone/agent cycles in one run -> agent_timeout, tripled Claude usage).
    // Give it a timeout that covers the full agent budget and a single attempt; a genuine
    // transient failure is recovered by the reaper re-queuing a FRESH run.
    const result = await step.do("dispatch to agent", {
      retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
      timeout: "110 minutes",
    }, async (): Promise<ContainerRunResult> => {
      const creds = await prepareRunCredentials(this.env, plan);
      if (!creds.githubToken) {
        return { ok: false, error: "no_github_token" };
      }
      // Recall prior memories for this project and inject as priorContext. Strictly
      // best-effort: any failure yields "" and the run proceeds exactly as before.
      let priorContext = "";
      try {
        const memory = getMemoryProvider(this.env);
        const bank = bankKeyFor(payload.userId, plan.projectId ?? payload.projectId);
        const [recalled, playbook] = await Promise.all([
          memory.recall({ bank, query: plan.objective, limit: 5 }),
          memory.mentalModel(bank),
        ]);
        priorContext = formatRecallForPrompt(recalled, playbook);
        await recordRunEvent(
          this.env,
          payload.runId,
          "memory.recall",
          priorContext ? "Recalled prior memories + playbook." : "No prior memories.",
          "info",
          { bank, hadContext: Boolean(priorContext) },
        ).catch(() => {});
      } catch {
        priorContext = "";
      }
      // Prepend the user's global soul + rules so every run honors them.
      try {
        const preamble = buildCorePreamble(await getCore(this.env, payload.userId));
        if (preamble) priorContext = [preamble, priorContext].filter(Boolean).join("\n\n---\n\n");
      } catch {
        /* best-effort */
      }
      const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
      const container = getContainer(containerNamespace, sandboxId);
      const response = await container.fetch(
        new Request("http://sandbox.internal/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: payload.runId,
            objective: plan.objective,
            priorContext,
            agentProvider: plan.agentProvider,
            mode: plan.mode ?? "implement",
            prNumber: plan.prNumber,
            repo,
            githubToken: creds.githubToken,
            githubTokens: creds.githubTokens,
            linearToken: creds.linearToken,
            aiGateway: creds.aiGateway,
            gemmaFallback: creds.gemmaFallback,
            claudeOauthToken: creds.claudeOauthToken,
            callbackBaseUrl: this.env.APP_URL,
            callbackSecret: this.env.INTERNAL_API_SECRET ?? "",
          }),
        }),
      );
      if (!response.ok) {
        throw new Error(`Container /run returned HTTP ${response.status}`);
      }
      return (await response.json()) as ContainerRunResult;
    });

    // Free the container slot immediately — otherwise it lingers RUNNING until
    // sleepAfter (120m, which must cover the agent run), orphaning one of the few
    // slots and starving the queue. Best-effort: sleepAfter is the backstop.
    await step.do("stop sandbox container", async () => {
      try {
        const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
        await getContainer(containerNamespace, sandboxId).stop();
      } catch {
        // ignore — the run already produced its result; sleepAfter cleans up eventually
      }
    });

    await step.do("record agent result", async () => {
      const testNote = result.testsRun
        ? ` · tests ${result.testsPassed ? "passed" : "failed"}`
        : "";
      await recordRunEvent(
        this.env,
        payload.runId,
        "agent.result",
        result.ok
          ? `Agent completed. PR: ${result.prUrl ?? "(none)"}${result.prDraft ? " (draft)" : ""}${result.merged ? " — MERGED ✅" : result.mergeReason ? ` (not merged: ${result.mergeReason})` : ""}${testNote}`
          : `Agent finished without a PR: ${result.error ?? "unknown"}${testNote}`,
        result.ok ? "info" : "warn",
        {
          prUrl: result.prUrl ?? null,
          prDraft: result.prDraft ?? null,
          merged: result.merged ?? null,
          mergeReason: result.mergeReason ?? null,
          branch: result.branch ?? null,
          prNumber: result.prNumber ?? null,
          testsRun: result.testsRun ?? null,
          testsPassed: result.testsPassed ?? null,
          testExitCode: result.testExitCode ?? null,
          projectType: result.projectType ?? null,
          logs: result.logs ? redactSecrets(result.logs).slice(-4000) : null,
          // The agent's own stdout — what Claude actually said/did. Essential for
          // diagnosing no_changes / agent_error runs.
          summary: result.summary ? redactSecrets(result.summary).slice(-4000) : null,
          agentExitCode: result.agentExitCode ?? null,
        },
      );
      await recordUsage(this.env, payload.userId, "container_runtime", {
        runId: payload.runId,
        projectId: plan.projectId ?? payload.projectId,
        quantity: 1,
        unit: "minute",
        provider: "cloudflare-containers",
      });

      // Retain this run's outcome to agent memory. Off-the-hot-path via MEMORY_QUEUE
      // (the network call happens in the consumer); this step only reads events +
      // enqueues, both failure-tolerant, so it can never fail the run.
      const status = result.ok ? "completed" : "failed";
      const events = await all<{ event_type: string; message: string }>(
        this.env,
        "SELECT event_type, message FROM run_events WHERE run_id = ? ORDER BY id ASC",
        [payload.runId],
      );
      const record = summarizeRunForMemory(
        { id: payload.runId, objective: plan.objective, projectName: null, status },
        events.map((e) => ({ eventType: e.event_type, message: e.message })),
        {
          ok: result.ok,
          prUrl: result.prUrl ?? undefined,
          summary: result.summary ?? undefined,
          error: result.error ?? undefined,
        },
      );
      const projectId = plan.projectId ?? payload.projectId ?? null;
      await enqueueMemoryRetain(this.env, {
        kind: "retain",
        runId: payload.runId,
        userId: payload.userId,
        projectId,
        bank: bankKeyFor(payload.userId, projectId),
        content: result.prUrl ? `${record.content}\nPR: ${result.prUrl}` : record.content,
        context: { ...record.context, outcome: record.outcome, projectId },
        tags: [status, "fly-dev", ...(projectId ? [projectId] : [])],
        ts: Date.now(),
      });
    });

    if (result.ok && linearIssueId) {
      await step.do("linear write-back", async () => {
        const linearToken = await getValidLinearToken(this.env, plan.userId);
        if (!linearToken) {
          await recordRunEvent(this.env, payload.runId, "linear.skipped", "No Linear token; skipping write-back.", "warn");
          return;
        }
        await writeBackToLinear(linearToken, {
          issueId: linearIssueId,
          teamId: plan.linearTeamId,
          prUrl: result.prUrl ?? null,
          summary: result.summary ?? "",
        });
        await recordRunEvent(this.env, payload.runId, "linear.updated", "Linear issue updated with PR + status.", "info");
      });
    }

    await step.do("mark run done", async () => {
      if (result.ok) {
        await markRunCompleted(this.env, payload.runId, {
          prUrl: result.prUrl,
          commitSha: result.commitSha,
          branchName: result.branch,
        });
      } else {
        await markRunFailed(this.env, payload.runId, new Error(result.error ?? "Agent produced no changes"));
      }
    });

    return {
      runId: payload.runId,
      sandboxId,
      status: result.ok ? "completed" : "failed",
      prUrl: result.prUrl ?? null,
    };
  }
}

// Required by @cloudflare/containers so a Workflow step can resolve the
// container's DO via ctx.exports.ContainerProxy.
export { ContainerProxy };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/agents/")) {
      const routed = await routeAgentRequest(request, env).catch(() => null);
      if (routed) return routed;
    }
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<WorkQueueMessage | MemoryRetainMessage>, env: Env): Promise<void> {
    // Agent-memory retains run on their own queue, decoupled from run admission.
    if (batch.queue === "fly-dev-memory") {
      await consumeMemoryRetains(batch as MessageBatch<MemoryRetainMessage>, env);
      return;
    }
    const workBatch = batch as MessageBatch<WorkQueueMessage>;
    const maxInstances = Number.parseInt(env.MAX_CONTAINER_INSTANCES ?? "8", 10);

    // Read the live active-run count ONCE per batch, then reserve slots locally as we
    // admit each start-run. With max_concurrency:1 (wrangler.jsonc) the queue runs one
    // consumer invocation at a time, so a single read-then-reserve loop is the whole
    // admission gate — no two invocations can both read a stale count and over-admit.
    const baseActive = await getActiveRunCount(env);
    let reservedThisBatch = 0;

    for (const message of workBatch.messages) {
      try {
        if (message.body.action === "start-run") {
          // Gate on the count we read once plus what we've already reserved in this
          // batch. No free slot → retry later (the message redelivers).
          if (baseActive + reservedThisBatch >= maxInstances) {
            message.retry();
            continue;
          }

          const run = await first<{ objective: string }>(
            env,
            "SELECT objective FROM runs WHERE id = ?",
            [message.body.runId],
          );
          // Reserve the slot BEFORE dispatching so a throw mid-dispatch doesn't let the
          // next message in this batch reuse the slot we were about to consume.
          reservedThisBatch++;
          await startRunWorkflow(env, {
            runId: message.body.runId,
            userId: message.body.userId,
            projectId: message.body.projectId,
            objective: run?.objective ?? "Continue queued fly-dev run",
            attempt: message.body.attempt,
          });
          message.ack();
        } else {
          // Unknown action: ack so it does not loop to the DLQ. See SANDBOX_REVIEW.md B5.
          console.warn("Unhandled queue action", message.body.action);
          message.ack();
        }
      } catch (error) {
        await markRunFailed(env, message.body.runId, error);
        message.retry();
      }
    }
  },

  // Self-healing reaper (cron). Re-queues runs that failed with a transient/
  // recoverable error or got stuck mid-flight, so nothing simply sits in `failed`.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await reapStuckRuns(env);
    await releaseOrphanedApprovals(env);
    await retryNoChangeStragglers(env);
    await reapMergeablePRs(env);
    await reflectMemoryBanks(env);
  },
};

// Consumes the fly-dev-memory queue: call the MemoryProvider.retain, then mirror the
// result into the agent_memories ledger. Throw on retain failure so the queue retries
// (→ DLQ after max_retries); the run that produced the memory already completed.
async function consumeMemoryRetains(batch: MessageBatch<MemoryRetainMessage>, env: Env): Promise<void> {
  const memory = getMemoryProvider(env);
  for (const message of batch.messages) {
    try {
      const m = message.body;
      // First retain to a bank: ensure config + standing playbook exist (once per bank).
      const setupKey = `memory:bank-init:${m.bank}`;
      if (!(await env.CACHE.get(setupKey))) {
        await memory.ensureBank(m.bank);
        await env.CACHE.put(setupKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
      }
      const res = await memory.retain({
        bank: m.bank,
        content: m.content,
        context: m.context,
        tags: m.tags,
        ts: m.ts,
      });
      if (!res.ok) throw new Error(res.error ?? "retain_failed");
      // Mirror into the local ledger (best-effort; never re-throw — retain succeeded).
      await runSql(
        env,
        `INSERT INTO agent_memories
           (id, user_id, project_id, session_id, memory_type, title, content, source, metadata_json, hindsight_id, bank_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id("mem"),
          m.userId,
          m.projectId ?? null,
          m.runId,
          "run_outcome",
          `Run ${m.runId} (${String(m.context.outcome ?? "?")})`.slice(0, 200),
          m.content,
          "run",
          JSON.stringify(m.context),
          res.hindsightId ?? null,
          m.bank,
        ],
      ).catch(() => {});
      message.ack();
    } catch {
      message.retry();
    }
  }
}

// Optional explicit reflect nudge. Default mode "auto" relies on Hindsight's own
// consolidation-triggered mental-model refresh, so this is a no-op unless the
// operator sets MEMORY_REFLECT_MODE="cron". Throttled per bank via CACHE.
async function reflectMemoryBanks(env: Env): Promise<void> {
  if (env.MEMORY_REFLECT_MODE !== "cron" || env.MEMORY_ENABLED !== "true") return;
  try {
    const memory = getMemoryProvider(env);
    const banks = await all<{ bank_key: string }>(
      env,
      `SELECT DISTINCT bank_key FROM agent_memories
       WHERE bank_key IS NOT NULL AND updated_at > datetime('now', '-1 day') LIMIT 25`,
    );
    for (const { bank_key } of banks) {
      const throttleKey = `memory:reflect:${bank_key}`;
      if (await env.CACHE.get(throttleKey)) continue;
      await memory.reflect({ bank: bank_key, query: "Refresh the project playbook from recent runs." });
      await env.CACHE.put(throttleKey, "1", { expirationTtl: 60 * 60 * 6 }).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}



async function reapStuckRuns(env: Env): Promise<void> {
  // 1) Recently-failed runs with a retryable error, under the attempt cap.
  // 2) Runs stuck in `running` well past the agent timeout (container died).
  const candidates = await all<{
    id: string;
    user_id: string;
    project_id: string | null;
    status: string;
    last_error: string | null;
    metadata_json: string;
    last_heartbeat_at: string | null;
  }>(
    env,
    `SELECT id, user_id, project_id, status, last_error, metadata_json, last_heartbeat_at
       FROM runs
      WHERE (status = 'failed'  AND finished_at >= datetime('now','-6 hours'))
         OR (status IN ('running','starting') AND COALESCE(last_heartbeat_at, started_at) <= datetime('now','-8 minutes'))
         OR (status = 'queued'  AND updated_at  <= datetime('now','-15 minutes'))
      ORDER BY updated_at ASC
      LIMIT 50`,
  );

  for (const run of candidates) {
    const kind = reapKind(run.status);
    // Error retries require a retryable error; stuck states (capacity wait / lost queue
    // message) are always eligible regardless of last_error.
    if (kind === "error" && !isRetryableError(run.last_error)) continue;

    // NOTE: we deliberately do NOT touch the container here. Containers self-exit when
    // their /run finishes (container/server.mjs), so deploy/crash orphans clean
    // themselves. Calling getContainer(...).stop() on the SAME sandboxId we're about to
    // re-dispatch only churns the DO (and stop() is a no-op vs a SIGTERM-handling exit).

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }

    // Error retries and capacity re-dispatches draw from SEPARATE budgets so a backlog
    // draining through limited slots never falsely fails a run (see reaper-policy).
    const field = reapBudgetField(kind);
    const used = typeof meta[field] === "number" ? (meta[field] as number) : 0;
    const cap = reapBudgetCap(kind);
    if (used >= cap) {
      // Don't strand it: if it's not already terminal, fail it loudly so it leaves
      // the queue and surfaces for attention. Idempotent via meta.exhausted.
      if (run.status !== "failed" && meta.exhausted !== true) {
        meta.exhausted = true;
        await env.DB.prepare(
          `UPDATE runs SET status='failed', last_error='retries_exhausted', finished_at=CURRENT_TIMESTAMP, metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,
        )
          .bind(JSON.stringify(meta), run.id, run.status)
          .run();
        await recordRunEvent(env, run.id, "run.exhausted", `Auto-retry gave up after ${cap} ${kind} attempts (last: ${run.last_error ?? run.status}). Needs attention.`, "error");
      }
      continue;
    }
    meta[field] = used + 1;
    const seq = nextDispatchSeq(meta);

    // Reset started_at/finished_at so each attempt gets a FRESH 110-minute running clock.
    // Otherwise COALESCE(started_at, …) in markRunStarted keeps the original timestamp and
    // the next tick re-reaps the run as 'stuck running' seconds after it restarts.
    // Flip only if still in the state we read (avoids racing a concurrent recovery).
    const updated = await env.DB.prepare(
      `UPDATE runs SET status = 'queued', last_error = NULL, started_at = NULL, finished_at = NULL, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?`,
    )
      .bind(JSON.stringify(meta), run.id, run.status)
      .run();
    if (!updated.meta.changes) continue;

    await recordRunEvent(
      env,
      run.id,
      "run.retry",
      `Self-healing: ${kind} re-dispatch ${used + 1}/${cap} after ${kind === "stuck" ? `stuck ${run.status}` : run.last_error}.`,
      "info",
      { attempt: seq },
    );
    await enqueueRun(env, {
      runId: run.id,
      userId: run.user_id,
      projectId: run.project_id ?? undefined,
      action: "start-run",
      attempt: seq,
    });
  }
}

// Approval-orphan reaper: when human approval is disabled, runs created during the
// approval era sit in `waiting_approval` forever — the gate that parked them is gone.
// Release them to `queued` and dispatch, mirroring approveRun (minus the human record).
async function releaseOrphanedApprovals(env: Env): Promise<void> {
  if (env.REQUIRE_HUMAN_APPROVAL === "true") return;
  const orphans = await all<{
    id: string;
    user_id: string;
    project_id: string | null;
  }>(
    env,
    `SELECT id, user_id, project_id
       FROM runs
      WHERE status = 'waiting_approval'
      ORDER BY created_at ASC
      LIMIT 50`,
  );

  for (const run of orphans) {
    // Status-guarded so we never race the approve endpoint or a concurrent tick.
    const updated = await env.DB.prepare(
      `UPDATE runs
          SET status = 'queued', approval_required = 0, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'waiting_approval'`,
    )
      .bind(run.id)
      .run();
    if (!updated.meta.changes) continue;

    await recordRunEvent(
      env,
      run.id,
      "run.auto_released",
      "Self-healing: approval gating disabled; orphaned run released to the queue.",
      "info",
    );
    await enqueueRun(env, {
      runId: run.id,
      userId: run.user_id,
      projectId: run.project_id ?? undefined,
      action: "start-run",
    });
  }
}

// no_changes reaper: `no_changes` is normally terminal, but empty output produced
// during a dead-OAuth-token window was auth — not the work being done. Give each such
// run EXACTLY ONE recovery retry, marked in metadata so a genuine no-op never loops.
async function retryNoChangeStragglers(env: Env): Promise<void> {
  const rows = await all<{
    id: string;
    user_id: string;
    project_id: string | null;
    metadata_json: string;
  }>(
    env,
    `SELECT id, user_id, project_id, metadata_json
       FROM runs
      WHERE status = 'failed' AND last_error = 'no_changes'
      ORDER BY updated_at ASC
      LIMIT 50`,
  );

  for (const run of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    if (!shouldRetryNoChanges(meta)) continue;
    meta.noChangesRetried = true;
    // A one-time recovery, bounded by the marker above — it does NOT consume the error
    // budget. It DOES need a fresh dispatch sequence: the run already ran once on the
    // bare `${runId}` instance, so re-enqueuing without one would idempotently no-op.
    const seq = nextDispatchSeq(meta);

    const updated = await env.DB.prepare(
      `UPDATE runs
          SET status = 'queued', last_error = NULL, started_at = NULL, finished_at = NULL, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed' AND last_error = 'no_changes'`,
    )
      .bind(JSON.stringify(meta), run.id)
      .run();
    if (!updated.meta.changes) continue;

    await recordRunEvent(
      env,
      run.id,
      "run.retry",
      "Self-healing: one-time retry of a no_changes run (possible auth-window empty output).",
      "info",
      { attempt: seq },
    );
    await enqueueRun(env, {
      runId: run.id,
      userId: run.user_id,
      projectId: run.project_id ?? undefined,
      action: "start-run",
      attempt: seq,
    });
  }
}

// Merge reaper: for completed runs whose PR wasn't merged in-run (e.g. external CI
// was still pending), re-check the PR and squash-merge once GitHub reports it
// mergeable with green checks. Tracks attempts/done in run metadata.
const MAX_MERGE_ATTEMPTS = 24; // ~2h at the 5-min cron cadence

async function reapMergeablePRs(env: Env): Promise<void> {
  const candidates = await all<{
    id: string;
    user_id: string;
    pr_url: string | null;
    metadata_json: string;
  }>(
    env,
    `SELECT id, user_id, pr_url, metadata_json
       FROM runs
      WHERE status = 'completed' AND pr_url IS NOT NULL
        AND finished_at >= datetime('now','-12 hours')
      ORDER BY finished_at DESC
      LIMIT 30`,
  );

  for (const run of candidates) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    if (meta.mergeDone === true) continue;
    const attempts = typeof meta.mergeAttempts === "number" ? meta.mergeAttempts : 0;
    if (attempts >= MAX_MERGE_ATTEMPTS) continue;

    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(run.pr_url ?? "");
    if (!m) continue;
    const [, owner, repo, prNum] = m;
    if (!owner || !repo || !prNum) continue;
    const token = env.GITHUB_PAT || (await getDecryptedToken(env, run.user_id, "github"));
    if (!token) continue;

    const result = await mergeWhenGreen(token, owner, repo, Number(prNum)).catch(() => ({
      merged: false as const,
      reason: "exception",
    }));
    meta.mergeAttempts = attempts + 1;
    if (result.reason === "draft" || result.reason === "tests_failing") {
      const draftAttempts = (typeof meta.draftAttempts === "number" ? meta.draftAttempts : 0) + 1;
      meta.draftAttempts = draftAttempts;
      if (draftAttempts >= 3) {
        meta.mergeDone = true; // stop polling; it won't merge until a human/agent fixes it
        await recordRunEvent(env, run.id, "merge.parked", `PR #${prNum} is a draft / tests failing after ${draftAttempts} checks — parked, needs attention.`, "warn");
      }
    }
    if (result.merged || ("alreadyMerged" in result && result.alreadyMerged)) {
      meta.mergeDone = true;
    }
    await env.DB.prepare("UPDATE runs SET metadata_json = ? WHERE id = ?")
      .bind(JSON.stringify(meta), run.id)
      .run();
    if (result.merged) {
      await recordRunEvent(env, run.id, "merge.reaped", `PR #${prNum} merged once checks went green.`, "info");
    }
  }
}

function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "github" || value === "linear";
}
