/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { getMemoryProvider, bankKeyFor } from "./memory";
import { recordUsage } from "./data";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const CHUNK_CHARS = 2000;
const MAX_CHUNKS = 60; // cap so one big doc can't flood a bank

// Split long text into ~CHUNK_CHARS pieces on paragraph/line boundaries.
function chunk(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const out: string[] = [];
  let buf = "";
  for (const para of clean.split(/\n{2,}/)) {
    if ((buf + "\n\n" + para).length > CHUNK_CHARS && buf) {
      out.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (out.length >= MAX_CHUNKS) break;
  }
  if (buf.trim() && out.length < MAX_CHUNKS) out.push(buf.trim());
  return out.slice(0, MAX_CHUNKS);
}

async function extractText(env: Env, file: File): Promise<{ text: string; via: string }> {
  const name = file.name.toLowerCase();
  const type = file.type;
  if (type.startsWith("text/") || /\.(md|markdown|txt|text)$/.test(name)) {
    return { text: await file.text(), via: "text" };
  }
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    const { getDocumentProxy, extractText: pdfExtract } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await pdfExtract(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n\n") : text, via: "pdf" };
  }
  if (type.startsWith("image/") || /\.(png|jpe?g)$/.test(name)) {
    // Vision OCR/caption via the AI binding so an image becomes searchable text.
    const bytes = [...new Uint8Array(await file.arrayBuffer())];
    const raw = await (env.AI as unknown as { run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown> }).run(
      "@cf/llava-hf/llava-1.5-7b-hf",
      { image: bytes, prompt: "Transcribe all text in this image verbatim, then briefly describe it for a knowledge base.", max_tokens: 1024 },
      { gateway: { id: env.AI_GATEWAY_ID || "x" } },
    );
    const desc = (raw as { description?: string; response?: string })?.description ?? (raw as { response?: string })?.response ?? "";
    return { text: desc, via: "image-ocr" };
  }
  throw new Error(`Unsupported file type: ${file.type || file.name}`);
}

export async function ingestKnowledge(env: Env, user: CurrentUser, form: FormData): Promise<Response> {
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file provided" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return Response.json({ error: "File too large (max 15 MB)" }, { status: 413 });

  const projectRaw = form.get("projectId");
  const projectId = typeof projectRaw === "string" && projectRaw && projectRaw !== "global" ? projectRaw : null;
  const bank = bankKeyFor(user.id, projectId);

  let extracted: { text: string; via: string };
  try {
    extracted = await extractText(env, file);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not read file" }, { status: 422 });
  }
  const chunks = chunk(extracted.text);
  if (chunks.length === 0) {
    return Response.json({ error: "No text could be extracted from this file." }, { status: 422 });
  }

  const memory = getMemoryProvider(env);
  let stored = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await memory
      .retain({
        bank,
        content: chunks[i] ?? "",
        context: { source: file.name, kind: extracted.via, chunk: i + 1, of: chunks.length },
        tags: ["knowledge", extracted.via],
      })
      .catch(() => ({ ok: false }) as { ok: boolean });
    if (res.ok) stored += 1;
  }

  await recordUsage(env, user.id, "knowledge_ingest", { projectId, metadata: { file: file.name, chunks: stored, via: extracted.via } }).catch(() => undefined);

  if (stored === 0) {
    return Response.json({ error: "Extracted text but the memory store rejected it. Try again." }, { status: 502 });
  }
  return Response.json({ ok: true, bank, file: file.name, via: extracted.via, chunks: stored });
}
