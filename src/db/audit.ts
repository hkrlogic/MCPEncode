/** Tool-call and publish-status audit logs. */
import type { Database } from "./types.ts";
import type { AuditRow, ItemStatus } from "./models.ts";
import { allRows, runSql } from "./query-helpers.ts";

export async function writeAudit(
  db: Database,
  event: { actorSub: string; tool: string; success: boolean; detail?: string },
): Promise<void> {
  await runSql(
    db,
    `INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    event.actorSub,
    event.tool,
    event.success,
    event.detail ?? "",
    Date.now(),
  );
}

export async function listAudit(db: Database, limit = 50): Promise<AuditRow[]> {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await allRows<{
    id: string;
    actor_sub: string;
    tool: string;
    success: boolean;
    detail: string;
    created_at: number;
  }>(
    db,
    `SELECT id, actor_sub, tool, success, detail, created_at
     FROM audit_events
     ORDER BY created_at DESC
     LIMIT ?`,
    capped,
  );
  return rows.map((row) => ({
    id: row.id,
    actor_sub: row.actor_sub,
    tool: row.tool,
    success: row.success === true,
    detail: row.detail,
    created_at: row.created_at,
  }));
}

/** Record one item status transition (publish gate). */
export async function writePublishAudit(
  db: Database,
  event: {
    libraryId: string;
    itemId: string;
    actorSub: string;
    fromStatus: ItemStatus;
    toStatus: ItemStatus;
  },
): Promise<void> {
  await runSql(
    db,
    `INSERT INTO publish_audit (id, library_id, item_id, actor_sub, from_status, to_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    event.libraryId,
    event.itemId,
    event.actorSub,
    event.fromStatus,
    event.toStatus,
    Date.now(),
  );
}
