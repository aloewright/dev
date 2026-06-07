/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { all, first, id, runSql } from "./data";
import { redactSecrets } from "./crypto";

export type Workflow = {
  id: string;
  name: string;
  description: string;
  template: string;
  updatedAt: string;
};

export async function listWorkflows(env: Env, user: CurrentUser): Promise<Response> {
  const rows = await all<Workflow>(
    env,
    `SELECT id, name, description, template, updated_at AS updatedAt
       FROM workflows WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`,
    [user.id],
  );
  return Response.json({ workflows: rows });
}

export async function saveWorkflow(
  env: Env,
  user: CurrentUser,
  payload: { id?: unknown; name?: unknown; description?: unknown; template?: unknown },
): Promise<Response> {
  const name = (typeof payload.name === "string" ? payload.name : "").trim().slice(0, 120);
  if (!name) return Response.json({ error: "A workflow name is required" }, { status: 400 });
  const description = redactSecrets(typeof payload.description === "string" ? payload.description : "").slice(0, 2000);
  const template = redactSecrets(typeof payload.template === "string" ? payload.template : "").slice(0, 20_000);

  // Update only when the row belongs to this user; otherwise create.
  if (typeof payload.id === "string" && payload.id) {
    const owned = await first<{ id: string }>(env, "SELECT id FROM workflows WHERE id = ? AND user_id = ?", [payload.id, user.id]);
    if (owned) {
      await runSql(
        env,
        "UPDATE workflows SET name = ?, description = ?, template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
        [name, description, template, payload.id, user.id],
      );
      return Response.json({ id: payload.id, name, description, template });
    }
  }
  const newId = id("wf");
  await runSql(
    env,
    "INSERT INTO workflows (id, user_id, name, description, template) VALUES (?, ?, ?, ?, ?)",
    [newId, user.id, name, description, template],
  );
  return Response.json({ id: newId, name, description, template });
}

export async function deleteWorkflow(env: Env, user: CurrentUser, workflowId: string): Promise<Response> {
  await runSql(env, "DELETE FROM workflows WHERE id = ? AND user_id = ?", [workflowId, user.id]);
  return Response.json({ ok: true });
}
