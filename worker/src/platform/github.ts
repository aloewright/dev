/* AGPL-3.0-or-later */
import type { Env } from "../env";

// Mint a GitHub App installation token scoped to a single repository with
// least-privilege permissions. This keeps the broad user OAuth token out of the
// code-executing sandbox. Returns null when no GitHub App is configured (the
// caller falls back to the user's OAuth token). See SANDBOX_REVIEW.md S3.
export async function getInstallationToken(
  env: Env,
  owner: string,
  repo: string,
): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return null;
  }

  const appJwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const installation = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    { headers: ghHeaders(appJwt) },
  );
  if (!installation.ok) {
    return null;
  }
  const { id: installationId } = (await installation.json()) as { id?: number };
  if (!installationId) {
    return null;
  }

  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...ghHeaders(appJwt), "content-type": "application/json" },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!tokenResponse.ok) {
    return null;
  }
  const { token } = (await tokenResponse.json()) as { token?: string };
  return token ?? null;
}

type MergeOutcome = { merged: boolean; alreadyMerged?: boolean; reason: string };

// Squash-merge a PR ONLY when GitHub reports it open, non-draft, mergeable=true,
// and its checks are neither failing nor pending. Safe to call repeatedly from a
// cron reaper — it polls toward green and is a no-op once merged.
export async function mergeWhenGreen(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<MergeOutcome> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "fly-dev",
    "x-github-api-version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const prRes = await fetch(`${base}/pulls/${prNumber}`, { headers });
  if (!prRes.ok) return { merged: false, reason: `pr_http_${prRes.status}` };
  const pr = (await prRes.json()) as {
    merged?: boolean;
    mergeable?: boolean | null;
    draft?: boolean;
    state?: string;
    head?: { sha?: string };
  };
  if (pr.merged) return { merged: false, alreadyMerged: true, reason: "already_merged" };
  if (pr.state !== "open") return { merged: false, alreadyMerged: true, reason: `state_${pr.state}` };
  if (pr.draft) return { merged: false, reason: "draft" };
  if (pr.mergeable !== true) return { merged: false, reason: "not_mergeable" };

  const sha = pr.head?.sha;
  if (!sha) return { merged: false, reason: "no_sha" };
  const checks = await combinedChecksState(base, sha, headers);
  if (checks === "failure") return { merged: false, reason: "checks_failing" };
  if (checks === "pending") return { merged: false, reason: "checks_pending" };

  const mergeRes = await fetch(`${base}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    // Always SHA-lock so GitHub rejects (409) a merge if the branch advanced since
    // we verified its checks.
    body: JSON.stringify({ merge_method: "squash", sha }),
  });
  if (mergeRes.ok) return { merged: true, reason: "merged" };
  // 405 = not mergeable now (already merged / closed / lost a race). Treat as done.
  if (mergeRes.status === 405) return { merged: false, alreadyMerged: true, reason: "merge_405" };
  return { merged: false, reason: `merge_http_${mergeRes.status}` };
}

async function combinedChecksState(
  base: string,
  sha: string,
  headers: Record<string, string>,
): Promise<"success" | "pending" | "failure"> {
  const cr = (await fetch(`${base}/commits/${sha}/check-runs`, { headers })
    .then((r) => (r.ok ? r.json() : { check_runs: [] }))
    .catch(() => ({ check_runs: [] }))) as { check_runs?: Array<{ status?: string; conclusion?: string | null }> };
  const st = (await fetch(`${base}/commits/${sha}/status`, { headers })
    .then((r) => (r.ok ? r.json() : { state: "" }))
    .catch(() => ({ state: "" }))) as { state?: string };
  const runs = cr.check_runs ?? [];
  const failed =
    st.state === "failure" ||
    runs.some((r) =>
      ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion ?? ""),
    );
  if (failed) return "failure";
  const pending = st.state === "pending" || runs.some((r) => r.status !== "completed");
  return pending ? "pending" : "success";
}

// Search GitHub for a merged PR that references issueIdentifier (e.g. "FLY-42")
// in its title or body. Uses the App installation token if available, falls back
// to GITHUB_PAT.
//
// Tri-state result:
//   true  — a definite answer: a merged PR referencing the issue exists.
//   false — a definite answer: no merged PR exists.
//   null  — UNKNOWN: the check could not be completed (no token, non-OK HTTP
//           response, or a transport/parse exception). Callers MUST treat null
//           as "don't know" and NOT as "not merged", otherwise a transient
//           GitHub API failure triggers a false-positive takeover run.
export async function findMergedPrForIssue(
  env: Env,
  owner: string,
  repo: string,
  issueIdentifier: string,
): Promise<boolean | null> {
  try {
    const token =
      (await getInstallationToken(env, owner, repo)) ?? env.GITHUB_PAT ?? null;
    if (!token) return null;

    const q = `repo:${owner}/${repo} is:pr is:merged ${issueIdentifier} in:title,body`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: ghHeaders(token) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { total_count?: number };
    return (data.total_count ?? 0) > 0;
  } catch {
    return null;
  }
}

function ghHeaders(bearer: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    accept: "application/vnd.github+json",
    "user-agent": "fly-dev",
    "x-github-api-version": "2022-11-28",
  };
}

async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId };
  const signingInput = `${base64urlText(JSON.stringify(header))}.${base64urlText(JSON.stringify(payload))}`;
  const key = await importPkcs8(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlBytes(new Uint8Array(signature))}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64urlText(value: string): string {
  return base64urlBytes(new TextEncoder().encode(value));
}

function base64urlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function deleteRepository(
  token: string,
  owner: string,
  repo: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const headers = ghHeaders(token);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    method: "DELETE",
    headers,
  });

  if (response.ok || response.status === 204) {
    return { ok: true, status: response.status };
  }

  // Surface the status so the caller can distinguish "already gone" (404 — prune the
  // stale local cache row) from "missing delete_repo scope / not an admin" (403).
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return { ok: false, status: response.status, error: body.message ?? `HTTP ${response.status}` };
}

export async function renameRepository(
  token: string,
  owner: string,
  repo: string,
  newName: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const headers = { ...ghHeaders(token), "content-type": "application/json" };
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: newName }),
  });

  if (response.ok) {
    const data = (await response.json()) as { name: string };
    return { ok: true, name: data.name };
  }

  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return { ok: false, error: body.message ?? `HTTP ${response.status}` };
}
