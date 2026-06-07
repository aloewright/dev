/* AGPL-3.0-or-later */

export type Provider = "github" | "linear";

export type Overview = {
  user: {
    email: string | null;
    name: string | null;
    flyUserSlug: string;
    authSource: string;
  } | null;
  usage: {
    events: number;
    modelCalls: number;
    containerMinutes: number;
    deploys: number;
    browserCalls: number;
    firecrawlCalls: number;
    artifactWrites: number;
    costMicros: number;
  };
  connections: Array<{
    provider: Provider;
    status: string;
    accountName: string | null;
    updatedAt: string | null;
  }>;
  queue: {
    configured: boolean;
    pendingApproximation: number;
  };
  projects: Array<{
    id: string;
    name: string;
    status: string;
    url: string | null;
    repoMappingStatus: string;
    repoConfidence: number;
    repoUrl: string | null;
    suggestedRepo: string | null;
    activeRuns: number;
    failedRuns: number;
  }>;
  repos: Array<{
    id: string;
    owner: string;
    name: string;
    fullName: string;
    url: string;
    description: string | null;
    private: number;
    archived: number;
    openIssues: number;
    stars: number;
    language: string | null;
    pushedAt: string | null;
  }>;
  recentRuns: Array<{
    id: string;
    objective: string;
    status: string;
    projectName: string | null;
    autonomyMode: string;
    agentProvider: string;
    approvalRequired: number;
    createdAt: string;
    lastError: string | null;
  }>;
  recentArtifacts: Array<{
    id: string;
    kind: string;
    url: string | null;
    r2Key: string | null;
    createdAt: string;
  }>;
  templates: Array<{
    id: string;
    kind: string;
    repo: string;
    description: string;
    status: string;
  }>;
};

export type Project = Overview["projects"][number];
export type Repo = Overview["repos"][number];
export type RecentRun = Overview["recentRuns"][number];

export type TaskResponse = {
  id: string;
  status: string;
  approvalRequired: boolean;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priority: number;
  assignee: string | null;
  updatedAt: string | null;
};

export type ContinueResult = {
  summary: string;
  createdIssues: Array<{ id: string; identifier: string; url: string; title: string }>;
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};
