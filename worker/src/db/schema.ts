/* AGPL-3.0-or-later */
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  flyUserSlug: text("fly_user_slug").notNull().unique(),
  authSource: text("auth_source").notNull().default("fly"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const accountConnections = sqliteTable("account_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  externalAccountId: text("external_account_id"),
  accountName: text("account_name"),
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  scopes: text("scopes"),
  expiresAt: text("expires_at"),
  status: text("status").notNull().default("needs_connection"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const linearProjects = sqliteTable("linear_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  status: text("status").notNull().default("unknown"),
  url: text("url"),
  summary: text("summary"),
  description: text("description"),
  teamKey: text("team_key"),
  leadName: text("lead_name"),
  repoMappingStatus: text("repo_mapping_status").notNull().default("unmapped"),
  repoConfidence: real("repo_confidence").notNull().default(0),
  updatedAt: text("updated_at"),
  syncedAt: text("synced_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const githubRepos = sqliteTable("github_repos", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  githubId: integer("github_id").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  url: text("url").notNull(),
  description: text("description"),
  private: integer("private").notNull().default(0),
  fork: integer("fork").notNull().default(0),
  archived: integer("archived").notNull().default(0),
  defaultBranch: text("default_branch"),
  openIssues: integer("open_issues").notNull().default(0),
  stars: integer("stars").notNull().default(0),
  language: text("language"),
  pushedAt: text("pushed_at"),
  updatedAt: text("updated_at"),
  syncedAt: text("synced_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const repositoryMappings = sqliteTable("repository_mappings", {
  id: text("id").primaryKey(),
  linearProjectId: text("linear_project_id").notNull(),
  provider: text("provider").notNull().default("github"),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  url: text("url").notNull(),
  confidence: real("confidence").notNull().default(0),
  source: text("source").notNull().default("manual"),
  status: text("status").notNull().default("active"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  repoMappingId: text("repo_mapping_id"),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("queued"),
  autonomyMode: text("autonomy_mode").notNull().default("manual_approval"),
  agentProvider: text("agent_provider").notNull().default("codex"),
  sandboxId: text("sandbox_id"),
  approvalRequired: integer("approval_required").notNull().default(1),
  approvedAt: text("approved_at"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  prUrl: text("pr_url"),
  commitSha: text("commit_sha"),
  branchName: text("branch_name"),
  linearIssueId: text("linear_issue_id"),
  linearTeamId: text("linear_team_id"),
  lastError: text("last_error"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  eventType: text("event_type").notNull(),
  message: text("message").notNull(),
  severity: text("severity").notNull().default("info"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const usageEvents = sqliteTable("usage_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  runId: text("run_id"),
  category: text("category").notNull(),
  provider: text("provider"),
  quantity: real("quantity").notNull().default(1),
  unit: text("unit").notNull().default("event"),
  costMicros: integer("cost_micros").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  r2Key: text("r2_key"),
  url: text("url"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().unique(),
  repo: text("repo").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("active"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull().default("pending"),
  decidedAt: text("decided_at"),
  reason: text("reason"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  eventId: text("event_id"),
  eventType: text("event_type"),
  signatureValid: integer("signature_valid").notNull().default(0),
  payloadJson: text("payload_json").notNull(),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const agentMemories = sqliteTable("agent_memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  sessionId: text("session_id").notNull(),
  memoryType: text("memory_type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("session"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  hindsightId: text("hindsight_id"),
  bankKey: text("bank_key"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});
