/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";

// Worker-side text generation for the editor's /ai slash command. Routed through
// the AI Gateway via the sanctioned env.AI.run("@cf/...", { gateway }) pattern
// (browsers can't call the gateway directly — the token would be exposed).
const MODEL = "@cf/openai/gpt-oss-120b";

const SYSTEM =
  "You are a writing assistant embedded in a developer portal's text editor. " +
  "Follow the user's instruction and return ONLY the text to insert at the cursor " +
  "— no preamble, no explanation, no code fences unless the instruction asks for code.";

function readContent(raw: unknown): string {
  const r = raw as { choices?: Array<{ message?: { content?: string } }>; response?: unknown };
  const fromChoices = r?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) return fromChoices;
  if (typeof r?.response === "string" && r.response.trim()) return r.response;
  return "";
}

export async function generateText(env: Env, prompt: string, context: string): Promise<string> {
  const user = context.trim()
    ? `Existing text (for context):\n${context.slice(0, 6000)}\n\nInstruction: ${prompt}`
    : prompt;
  const raw = await (
    env.AI as unknown as { run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown> }
  ).run(
    MODEL,
    { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], max_tokens: 1200 },
    { gateway: { id: env.AI_GATEWAY_ID || "x" } },
  );
  return readContent(raw);
}

export async function generateTextResponse(env: Env, _user: CurrentUser, payload: { prompt?: unknown; context?: unknown }): Promise<Response> {
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) return Response.json({ error: "A prompt is required" }, { status: 400 });
  const context = typeof payload.context === "string" ? payload.context : "";
  try {
    const text = await generateText(env, prompt, context);
    if (!text) return Response.json({ error: "The model returned no text. Try rephrasing." }, { status: 502 });
    return Response.json({ text });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 502 });
  }
}
