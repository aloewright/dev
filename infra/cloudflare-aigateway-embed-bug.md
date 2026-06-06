# Bug report — AI Gateway Dynamic Routes fail for embedding models (`/compat/embeddings`)

**Product:** AI Gateway → Dynamic Routes
**Account ID:** 85d376fc54617bcb57185547f08e528b
**Gateway:** `x`
**Route:** `embed` (slug `dynamic/embed`)
**Severity:** Functional bug — dynamic routes are unusable for embeddings.

## Summary
A Dynamic Route whose model node points at a valid Workers AI **embedding** model returns a
`500 / internalCode 5017 "Configuration error: Failed to fetch configuration"` (and intermittently
`internalCode 2028 "Route terminated without valid response. Reason: Route has no elements"`) when
invoked via the OpenAI-compatible `/compat/embeddings` endpoint — even though the **exact same model
invoked directly (without the dynamic route) returns 200**. The route configuration is structurally
valid and was recreated from scratch. Chat-model dynamic routes on the same gateway work fine; only
the embeddings dynamic route fails.

## Expected behavior
`POST /compat/embeddings` with `{"model":"dynamic/embed"}` should resolve the route's
`workers-ai / @cf/baai/bge-m3` node and return an embedding vector, the same way the model returns one
when called directly.

## Actual behavior
The dynamic route returns `500` with `internalCode 5017` ("Failed to fetch configuration"), or
sometimes `2028` ("Route has no elements"). The identical model called directly returns `200` with a
1024-dim vector.

## Minimal reproduction
Endpoint base: `https://gateway.ai.cloudflare.com/v1/85d376fc54617bcb57185547f08e528b/x/compat/embeddings`
Headers: `Content-Type: application/json`, `cf-aig-authorization: Bearer <token>`, `cf-aig-skip-cache: true`

**(A) Via the dynamic route — FAILS:**
```
{"model":"dynamic/embed","input":"hello world"}
```
→ `HTTP 500` `{"name":"AiError","internalCode":5017,"httpCode":500,"message":"AiError: Configuration error: Failed to fetch configuration (<requestId>)"}`

**(B) The exact same model, called directly — SUCCEEDS:**
```
{"model":"workers-ai/@cf/baai/bge-m3","input":"hello world"}
```
→ `HTTP 200` — OpenAI-shaped embeddings response, 1024-dim vector.

Both requests were sent seconds apart, same account, same gateway token, cache disabled.

## The route config (valid, recreated fresh)
```json
[
  { "id": "START", "type": "start", "outputs": { "next": { "elementId": "model-start" } } },
  { "id": "model-start", "type": "model",
    "properties": { "provider": "workers-ai", "model": "@cf/baai/bge-m3", "timeout": 0, "retries": 0 },
    "outputs": { "success": { "elementId": "END" }, "fallback": { "elementId": "model-1780704398029" } } },
  { "id": "model-1780704398029", "type": "model",
    "properties": { "provider": "workers-ai", "model": "@cf/qwen/qwen3-embedding-0.6b", "timeout": 0, "retries": 0 },
    "outputs": { "success": { "elementId": "END" }, "fallback": { "elementId": "END" } } },
  { "id": "END", "type": "end", "outputs": {} }
]
```
Both referenced models (`@cf/baai/bge-m3`, `@cf/qwen/qwen3-embedding-0.6b`) return 200 / 1024-dim when
called directly through the gateway.

## Request IDs (for your logs — `5017` occurrences)
- 268a4364-8bab-4e51-8ba6-c3b358846f10
- 0d211f42-4e5f-458f-8af8-302cce478fe6
- 4365fcbf-ae58-459e-82d8-078e7361e326
- 6236dddd-c9e6-4970-b629-d620b8f930e0
- 32279445-6d1a-47ed-9d35-d8e2ceef3b33

## Notes
- Chat-model dynamic routes on the same gateway `x` (`dynamic/text_gen`, `dynamic/fast`,
  `dynamic/research_gen`) work correctly via `/compat/chat/completions`.
- The failure is specific to the **embeddings** path through Dynamic Routes.
- Deleting and recreating the route does not resolve it; the error alternates between `5017` and `2028`.
- A second, independently-created embeddings route (`dynamic/vectors`) reproduces the identical
  `5017` — confirming the failure is in the embeddings-through-dynamic-routes path, not a single
  corrupted route instance. (request ID `77e9657f-8f7d-4976-9be5-784d6de5cd47`)

## Impact
Dynamic Routes cannot be used for embeddings (no fallback/observability/routing for embedding traffic).
Workaround: bypass the dynamic route and call the embedding model directly
(`workers-ai/@cf/baai/bge-m3`), which works but loses the dynamic-route features.

---

## Where to file this
1. **Cloudflare Developers Discord → `#ai-gateway`** — fastest; the AI Gateway team watches it.
2. **Dashboard → Support → Contact Support → Open a ticket** (product: AI Gateway) — official record;
   the request IDs above let them pull the failing traces.
3. **community.cloudflare.com** (Developers → AI Gateway) — public paper trail.

## Workaround (until fixed)
Call the embedding model directly instead of through the dynamic route:
```
POST https://gateway.ai.cloudflare.com/v1/85d376fc54617bcb57185547f08e528b/x/compat/embeddings
Headers: Content-Type: application/json, cf-aig-authorization: Bearer <token>
Body:    {"model":"workers-ai/@cf/baai/bge-m3","input":"…"}
```
Returns 200 + a 1024-dim vector, keyless (Cloudflare unified billing). No dynamic route involved.
