/* AGPL-3.0-or-later */
import { Agent, routeAgentRequest } from "agents";
import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ContainerRunResult, CurrentUser, Env, RunWorkflowParams, WorkQueueMessage } from "./env";
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
  createTaskRun,
  enqueueRun,
  createTemplateApp,
  markRunCompleted,
  markRunFailed,
  markRunStarted,
  prepareRunCredentials,
  resolveRunPlan,
  startRunWorkflow,
  type CreateTaskPayload,
} from "./platform/orchestration";
import { writeBackToLinear } from "./platform/linear";
import { mergeWhenGreen } from "./platform/github";
import { continueProject } from "./platform/continue";
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

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    service: "fly-dev",
    url: c.env.APP_URL,
    bindings: {
      d1: Boolean(c.env.DB),
      r2: Boolean(c.env.ARTIFACTS),
      kv: Boolean(c.env.CACHE),
      queue: Boolean(c.env.WORK_QUEUE),
      workflow: Boolean(c.env.RUN_WORKFLOW),
      userWorkers: Boolean(c.env.USER_WORKERS),
      aiGateway: Boolean(c.env.AI),
      browser: Boolean(c.env.MYBROWSER),
    },
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

app.post("/api/tasks", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return createTaskRun(c.env, user, payload as CreateTaskPayload);
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
      await markRunStarted(this.env, payload.runId, sandboxIdValue);
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

    await step.do("start sandbox container", async () => {
      const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
      const container = getContainer(containerNamespace, sandboxId);
      await container.startAndWaitForPorts([8080], {
        instanceGetTimeoutMS: 30_000,
        portReadyTimeoutMS: 60_000,
        waitInterval: 1_000,
      });
    });

    // Credentials are resolved and used inside this single step so they are
    // never returned from a step (never persisted in Workflow storage). See S6.
    const result = await step.do("dispatch to agent", async (): Promise<ContainerRunResult> => {
      const creds = await prepareRunCredentials(this.env, plan);
      if (!creds.githubToken) {
        return { ok: false, error: "no_github_token" };
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
            agentProvider: plan.agentProvider,
            mode: plan.mode ?? "implement",
            prNumber: plan.prNumber,
            repo,
            githubToken: creds.githubToken,
            githubTokens: creds.githubTokens,
            linearToken: creds.linearToken,
            aiGateway: creds.aiGateway,
            claudeOauthToken: creds.claudeOauthToken,
          }),
        }),
      );
      if (!response.ok) {
        throw new Error(`Container /run returned HTTP ${response.status}`);
      }
      return (await response.json()) as ContainerRunResult;
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

  async queue(batch: MessageBatch<WorkQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.action === "start-run") {
          const run = await first<{ objective: string }>(
            env,
            "SELECT objective FROM runs WHERE id = ?",
            [message.body.runId],
          );
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
    await reapMergeablePRs(env);
  },
};

// Errors worth auto-retrying (infra/auth/transient). NOT no_changes (the agent
// legitimately produced nothing) or no_repository (a config problem a retry can't fix).
const RETRYABLE_ERRORS = [
  "clone_failed",
  "push_failed",
  "pr_failed",
  "commit_failed",
  "no_github_token",
  "agent_error",
  "Container /run returned",
  "exception",
  "Agent produced no changes",
];
const MAX_RUN_RETRIES = 3;

function isRetryableError(lastError: string | null): boolean {
  if (!lastError) return false;
  return RETRYABLE_ERRORS.some((needle) => lastError.includes(needle));
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
  }>(
    env,
    `SELECT id, user_id, project_id, status, last_error, metadata_json
       FROM runs
      WHERE (status = 'failed'  AND finished_at >= datetime('now','-6 hours'))
         OR (status = 'running' AND started_at  <= datetime('now','-110 minutes'))
         OR (status = 'queued'  AND updated_at  <= datetime('now','-15 minutes'))
      ORDER BY updated_at ASC
      LIMIT 50`,
  );

  for (const run of candidates) {
    // 'running'/'queued' are stuck STATES (lost container / lost queue message),
    // not error states, so they're always eligible regardless of last_error.
    const stuckState = run.status === "running" || run.status === "queued";
    if (!stuckState && !isRetryableError(run.last_error)) continue;

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(run.metadata_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const attempt = typeof meta.retryCount === "number" ? meta.retryCount : 0;
    if (attempt >= MAX_RUN_RETRIES) {
      // Don't strand it: if it's not already terminal, fail it loudly so it leaves
      // the queue and surfaces for attention. Idempotent via meta.exhausted.
      if (run.status !== "failed" && meta.exhausted !== true) {
        meta.exhausted = true;
        await env.DB.prepare(
          `UPDATE runs SET status='failed', last_error='retries_exhausted', finished_at=CURRENT_TIMESTAMP, metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,
        )
          .bind(JSON.stringify(meta), run.id, run.status)
          .run();
        await recordRunEvent(env, run.id, "run.exhausted", `Auto-retry gave up after ${MAX_RUN_RETRIES} attempts (last: ${run.last_error ?? run.status}). Needs attention.`, "error");
      }
      continue;
    }
    const nextAttempt = attempt + 1;
    meta.retryCount = nextAttempt;

    // Flip back to queued only if still in the state we read (avoids racing a
    // concurrently-recovering run).
    const updated = await env.DB.prepare(
      `UPDATE runs SET status = 'queued', last_error = NULL, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?`,
    )
      .bind(JSON.stringify(meta), run.id, run.status)
      .run();
    if (!updated.meta.changes) continue;

    await recordRunEvent(
      env,
      run.id,
      "run.retry",
      `Self-healing: auto-retry ${nextAttempt}/${MAX_RUN_RETRIES} after ${stuckState ? `stuck ${run.status}` : run.last_error}.`,
      "info",
      { attempt: nextAttempt },
    );
    await enqueueRun(env, {
      runId: run.id,
      userId: run.user_id,
      projectId: run.project_id ?? undefined,
      action: "start-run",
      attempt: nextAttempt,
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
