/** Tool-call and publish-status audit logs. */
import type { Database } from "./types.ts";
import type { AuditRow, ItemStatus } from "./models.ts";
import { allRows, runSql } from "./query-helpers.ts";

export async function writeAudit(
  db: Database,
  event: {
    actorSub: string;
    tool: string;
    success: boolean;
    detail?: string;
    /** The library the event happened in. list_audit on a Connect link shows only that library's events. */
    libraryId?: string | null;
  },
): Promise<void> {
  await runSql(
    db,
    `INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at, library_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    event.actorSub,
    event.tool,
    event.success,
    event.detail ?? "",
    Date.now(),
    event.libraryId ?? null,
  );
}

/**
 * Recent tool-call events for one library. There is no unscoped variant: the
 * log names items and people from every library, so a caller only ever sees
 * the library it is connected to.
 */
export async function listAudit(db: Database, libraryId: string, limit = 50): Promise<AuditRow[]> {
  if (!libraryId) throw new Error("library_id is required");
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await allRows<{
    id: string;
    actor_sub: string;
    tool: string;
    success: boolean;
    detail: string;
    created_at: number;
    username: string | null;
  }>(
    db,
    `SELECT e.id, e.actor_sub, e.tool, e.success, e.detail, e.created_at, a.username
     FROM audit_events e
     LEFT JOIN accounts a ON a.id = e.actor_sub
     WHERE e.library_id = ?
     ORDER BY e.created_at DESC
     LIMIT ?`,
    libraryId,
    capped,
  );
  return rows.map((row) => ({
    id: row.id,
    actor_sub: row.actor_sub,
    actor: row.username ?? (row.actor_sub.startsWith("reader-key:") ? "Reader key" : row.actor_sub),
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

export type AuditLogRow = AuditRow & {
  /** Username for built-in accounts, "Reader key", or the raw subject. */
  actor: string;
  library_id: string | null;
  library_name: string | null;
};

/**
 * One page of the web audit log, newest first. `libraryIds` limits it to those
 * libraries (a Publisher's); null means every event (Site admin). Returns one
 * extra row's worth of information as `hasMore`.
 */
export async function listAuditLog(
  db: Database,
  input: { libraryIds: string[] | null; limit?: number; offset?: number },
): Promise<{ rows: AuditLogRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  if (input.libraryIds && input.libraryIds.length === 0) return { rows: [], hasMore: false };
  const where = input.libraryIds ? "WHERE e.library_id = ANY(?::text[])" : "";
  const params: unknown[] = input.libraryIds ? [input.libraryIds] : [];
  const rows = await allRows<{
    id: string;
    actor_sub: string;
    tool: string;
    success: boolean;
    detail: string;
    created_at: number | string;
    library_id: string | null;
    library_name: string | null;
    username: string | null;
  }>(
    db,
    `SELECT e.id, e.actor_sub, e.tool, e.success, e.detail, e.created_at, e.library_id,
            l.name AS library_name, a.username
     FROM audit_events e
     LEFT JOIN libraries l ON l.id = e.library_id
     LEFT JOIN accounts a ON a.id = e.actor_sub
     ${where}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit + 1,
    offset,
  );
  return {
    hasMore: rows.length > limit,
    rows: rows.slice(0, limit).map((row) => ({
      id: row.id,
      actor_sub: row.actor_sub,
      actor: row.username ?? (row.actor_sub.startsWith("reader-key:") ? "Reader key" : row.actor_sub),
      tool: row.tool,
      success: row.success === true,
      detail: row.detail,
      created_at: Number(row.created_at),
      library_id: row.library_id,
      library_name: row.library_name,
    })),
  };
}
