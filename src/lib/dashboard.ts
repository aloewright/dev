/* AGPL-3.0-or-later */
import type { CSSProperties } from "react";
import type { Provider } from "@/types";

export const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
];

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const sectionHeader: CSSProperties = {
  borderBottom: "1px solid var(--mantine-color-default-border)",
};

export const rowBorder: CSSProperties = {
  borderTop: "1px solid var(--mantine-color-default-border)",
};

// Translate the OAuth/sign-in query params Cloudflare Access appends into a
// human banner. Returns null when there's nothing to announce.
export function getBannerFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("signin_required")) {
    const provider = params.get("provider");
    return provider ? `Sign in to connect ${provider}.` : "Sign in to continue.";
  }
  const oauthError = params.get("oauth_error");
  if (oauthError) {
    const provider = params.get("provider") ?? "the provider";
    return `OAuth with ${provider} failed: ${decodeURIComponent(oauthError)}. Try again.`;
  }
  const connected = params.get("connected");
  if (connected) {
    return `${connected} connected.`;
  }
  return null;
}

export function startConnect(provider: Provider) {
  window.location.href = `/api/integrations/${provider}/connect`;
}
