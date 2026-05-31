/* AGPL-3.0-or-later */
export type RepoCandidate = {
  owner: string;
  repo: string;
  url: string;
  source: "project_description" | "issue_link" | "branch" | "metadata";
  confidence: number;
};

const GITHUB_REPO_PATTERN =
  /(?:https?:\/\/github\.com\/|github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[)\]\s#?]|$)/g;
const OWNER_REPO_PATTERN = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;

export function extractGitHubReposFromText(
  text: string | null | undefined,
  source: RepoCandidate["source"] = "project_description",
): RepoCandidate[] {
  if (!text) {
    return [];
  }

  const candidates = new Map<string, RepoCandidate>();
  for (const match of text.matchAll(GITHUB_REPO_PATTERN)) {
    const owner = match[1] ?? "";
    const repo = cleanRepo(match[2] ?? "");
    addCandidate(candidates, owner, repo, source, 0.95);
  }

  for (const match of text.matchAll(OWNER_REPO_PATTERN)) {
    const owner = match[1] ?? "";
    const repo = cleanRepo(match[2] ?? "");
    if (owner.includes(".") || repo.includes(".")) {
      continue;
    }
    addCandidate(candidates, owner, repo, source, 0.55);
  }

  return [...candidates.values()];
}

export function repoMappingStatus(candidates: RepoCandidate[]): {
  status: "mapped" | "needs_review" | "unmapped";
  best: RepoCandidate | null;
} {
  if (candidates.length === 0) {
    return { status: "unmapped", best: null };
  }

  const sorted = [...candidates].sort((left, right) => right.confidence - left.confidence);
  const best = sorted[0] ?? null;
  const second = sorted[1];

  if (!best) {
    return { status: "unmapped", best: null };
  }

  if (best.confidence >= 0.9 && (!second || best.confidence - second.confidence >= 0.2)) {
    return { status: "mapped", best };
  }

  return { status: "needs_review", best };
}

export function normalizeRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function addCandidate(
  candidates: Map<string, RepoCandidate>,
  owner: string,
  repo: string,
  source: RepoCandidate["source"],
  confidence: number,
) {
  if (!owner || !repo || owner === "http" || owner === "https") {
    return;
  }

  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const existing = candidates.get(key);
  if (!existing || confidence > existing.confidence) {
    candidates.set(key, {
      owner,
      repo,
      url: normalizeRepoUrl(owner, repo),
      source,
      confidence,
    });
  }
}

function cleanRepo(repo: string): string {
  return repo.replace(/\.git$/i, "").replace(/[),.\]]+$/g, "");
}

// --- Name-based project -> repo matching ----------------------------------
// Now that the full github_repos list is synced, matching a Linear project to a
// repo by name is far more reliable than scraping the project description.

export type RepoLike = {
  owner: string;
  name: string;
  url: string;
  fullName: string;
  archived?: number;
  fork?: number;
  pushedAt?: string | null;
};

export type ProjectMatch =
  | { status: "mapped"; repo: RepoLike; confidence: number }
  | { status: "needs_review"; repo: RepoLike; confidence: number }
  | { status: "unmapped"; repo: null; confidence: 0 };

// kebab-case a display name the way repos are typically named:
// "Book Cook — Studio v2" -> "book-cook-studio-v2".
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Drop a trailing qualifier after a dash/colon separator surrounded by spaces:
// "Book Cook — Studio v2" -> "Book Cook", "AI Dev Sidebar — Unified" -> "AI Dev Sidebar".
function baseName(name: string): string {
  const parts = name.split(/\s+[—–:-]\s+/);
  return parts[0] ?? name;
}

function tokenSet(slug: string): Set<string> {
  return new Set(slug.split("-").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  return inter / (a.size + b.size - inter);
}

// Prefer a real, current repo when several candidates tie: non-archived,
// non-fork, then most recently pushed.
function pickBest(repos: RepoLike[]): RepoLike {
  return [...repos].sort((l, r) => {
    if ((l.archived ?? 0) !== (r.archived ?? 0)) return (l.archived ?? 0) - (r.archived ?? 0);
    if ((l.fork ?? 0) !== (r.fork ?? 0)) return (l.fork ?? 0) - (r.fork ?? 0);
    return (r.pushedAt ?? "").localeCompare(l.pushedAt ?? "");
  })[0]!;
}

export function matchProjectToRepo(projectName: string, repos: RepoLike[]): ProjectMatch {
  const full = slugifyName(projectName);
  const base = slugifyName(baseName(projectName));
  if (!full || repos.length === 0) {
    return { status: "unmapped", repo: null, confidence: 0 };
  }

  const byName = (rn: string) => rn.toLowerCase();

  // Tier 1 — exact slug match on the full name or the base name => auto-map.
  const exact = repos.filter((r) => byName(r.name) === full || byName(r.name) === base);
  if (exact.length > 0) {
    return { status: "mapped", repo: pickBest(exact), confidence: 1 };
  }

  // Tier 2 — one name is a dash-delimited prefix of the other => suggest.
  // ("fly-mail-evolution" ~ "fly-mail"; base "alex" -> repo "alex-chat")
  const prefix = repos.filter((r) => {
    const rn = byName(r.name);
    return full.startsWith(`${rn}-`) || rn.startsWith(`${base}-`);
  });
  if (prefix.length > 0) {
    return { status: "needs_review", repo: pickBest(prefix), confidence: 0.7 };
  }

  // Tier 3 — token overlap (Jaccard) >= 0.5 => suggest the strongest.
  const fullTokens = tokenSet(full);
  let best: RepoLike | null = null;
  let bestScore = 0;
  for (const r of repos) {
    const score = jaccard(fullTokens, tokenSet(byName(r.name)));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (best && bestScore >= 0.5) {
    return { status: "needs_review", repo: best, confidence: bestScore };
  }

  return { status: "unmapped", repo: null, confidence: 0 };
}
