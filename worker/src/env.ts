/* AGPL-3.0-or-later */
export type WorkQueueMessage = {
  runId: string;
  userId: string;
  projectId?: string;
  action: "start-run" | "sync-project" | "deploy-page";
  // Retry attempt number (0/undefined = first run). Gives each retry a distinct
  // Workflow instance id so re-running a failed run actually starts.
  attempt?: number;
};

export type RunWorkflowParams = {
  runId: string;
  userId: string;
  projectId?: string;
  objective: string;
  attempt?: number;
};

// Repository coordinates resolved for a run (non-secret).
export type RunRepoCoords = {
  owner: string;
  repo: string;
  baseBranch: string;
  url: string;
};

// Structured result returned by the in-container agent runner (container/server.mjs).
// Must never contain secrets — it is persisted in Workflow step state.
export type ContainerRunResult = {
  ok: boolean;
  prUrl?: string | null;
  prNumber?: number | null;
  prDraft?: boolean | null;
  branch?: string | null;
  commitSha?: string | null;
  diff?: string | null;
  summary?: string | null;
  logs?: string | null;
  error?: string | null;
  // Test gate (set when changes were produced and a test harness was detected).
  testsRun?: boolean | null;
  testsPassed?: boolean | null;
  testExitCode?: number | null;
  projectType?: string | null;
  testSummary?: string | null;
};

export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  SESSION_CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  TEMPLATE_ASSETS: R2Bucket;
  WORK_QUEUE: Queue<WorkQueueMessage>;
  RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  PROJECT_CONDUCTORS: DurableObjectNamespace;
  USER_WORKER_CONTROLLERS: DurableObjectNamespace;
  DEV_ORCHESTRATOR: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  USER_WORKERS: DispatchNamespace;
  AI: Ai;
  MYBROWSER?: unknown;
  APP_ENV: string;
  APP_URL: string;
  AI_GATEWAY_ID: string;
  APPLE_TEMPLATE_REPO: string;
  CLOUDFLARE_TEMPLATE_REPO: string;
  FIRECRAWL_WORKER_URL: string;
  FLY_AUTH_ORIGIN: string;
  PLAYWRIGHT_WORKER_URL: string;
  REQUIRE_HUMAN_APPROVAL: string;
  GITHUB_APP_ID?: string;
  BETTER_AUTH_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  INTERNAL_API_SECRET?: string;
  // fly.pm universal-login hub. Non-secret; safe in vars. dev.fly.pm forwards
  // the session cookie here to validate (replaces Cloudflare Access).
  AUTH_HUB_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // Personal access token used to list ALL repos. The GitHub App OAuth token is
  // limited to installed repos; a (fine-grained) PAT with repo access sees
  // everything. When set, it is preferred for repo sync. Secret.
  GITHUB_PAT?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AIG_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  // Continue flow. CONTINUE_AUTONOMY="true" lets the Continue button auto-approve
  // runs, bypassing REQUIRE_HUMAN_APPROVAL (operator opt-in). CONTINUE_EXECUTE_CAP
  // caps how many runs one Continue click starts. Both are non-secret vars.
  CONTINUE_AUTONOMY?: string;
  CONTINUE_EXECUTE_CAP?: string;
};

export type CurrentUser = {
  id: string;
  email: string | null;
  name: string | null;
  flyUserSlug: string;
  authSource: "fly" | "better-auth" | "dev" | "internal" | "cf-access";
};
