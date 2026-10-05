/** Item CRUD and status gate (draft / published / archived). */
import type { Database } from "./types.ts";
import { excerptOf, type ItemInput, type ListQuery } from "../items/schema.ts";
import type { ItemRow, ItemSummary, ReadScope } from "./models.ts";
import { writePublishAudit } from "./audit.ts";
import {
  allRows,
  asStatus,
  escapeLike,
  libraryWhere,
  parseLabels,
  runSql,
  snapshotFromItem,
  summaryFor,
  toItem,
  type SqlItem,
  getRow,
} from "./query-helpers.ts";
import { defaultLibraryId } from "./libraries.ts";

type ListHit = {
  id: string;
  library_id: string;
  name: string;
  labels: string;
  summary: string;
  status: string;
  updated_at: number;
};

function toSummary(row: ListHit): ItemSummary {
  return {
    id: row.id,
    library_id: row.library_id,
    name: row.name,
    labels: parseLabels(row.labels),
    summary: excerptOf(row.summary),
    status: asStatus(row.status),
    updated_at: row.updated_at,
  };
}

export async function listItems(
  db: Database,
  query: ListQuery = {},
  scope: ReadScope = { publishedOnly: true },
): Promise<ItemSummary[]> {
  if (!query.library_id) {
    throw new Error("library_id is required");
  }
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  // Name, labels, and summary only. The body stays in the table.
  const where = [libraryWhere(scope)];
  const params: unknown[] = [query.library_id];
  const label = query.label?.trim().toLowerCase();
  if (label) {
    where.push("JSON_CONTAINS(labels, JSON_QUOTE(?))");
    params.push(label);
  }
  const needle = query.q?.trim();
  if (needle) {
    const pattern = `%${escapeLike(needle)}%`;
    where.push(
      "(name LIKE ? ESCAPE '\\\\' OR summary LIKE ? ESCAPE '\\\\' OR labels LIKE ? ESCAPE '\\\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  params.push(limit, offset);
  const rows = await allRows<ListHit>(
    db,
    `SELECT id, library_id, name, labels, summary, status, updated_at
     FROM items
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
  );
  return rows.map((row) => toSummary(row));
}

export async function getItem(
  db: Database,
  id: string,
  scope: ReadScope & { libraryId?: string } = { publishedOnly: true },
): Promise<ItemRow | undefined> {
  if (scope.publishedOnly && !scope.libraryId) {
    throw new Error("library_id is required");
  }
  const row = scope.publishedOnly
    ? await getRow<SqlItem>(
        db,
        "SELECT * FROM items WHERE id = ? AND library_id = ? AND status = 'published'",
        id,
        scope.libraryId,
      )
    : await getRow<SqlItem>(db, "SELECT * FROM items WHERE id = ?", id);
  return row ? toItem(row) : undefined;
}

type ItemSave = ItemInput & { summary?: string; details?: string | null };

export async function createItem(
  db: Database,
  input: ItemSave,
  actorSub: string,
  libraryId?: string,
): Promise<ItemRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const library_id = libraryId || (await defaultLibraryId(db));
  if (!library_id) throw new Error("library_id is required");
  await runSql(
    db,
    `INSERT INTO items (
       id, library_id, name, labels, summary, body, details, status,
       created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    id,
    library_id,
    input.name,
    JSON.stringify(input.labels),
    input.summary?.trim() || summaryFor(input.name, input.body),
    input.body,
    input.details ?? null,
    actorSub,
    actorSub,
    now,
    now,
  );
  const created = await getItem(db, id, { publishedOnly: false });
  if (!created) throw new Error("failed to read item after insert");
  return created;
}

export async function updateItem(
  db: Database,
  id: string,
  input: ItemSave,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing) return undefined;
  const now = Date.now();
  const unpublish = existing.status === "published";
  await runSql(
    db,
    `UPDATE items
     SET name = ?, labels = ?, summary = ?, body = ?, details = ?,
         status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
         updated_by = ?, updated_at = ?
     WHERE id = ?`,
    input.name,
    JSON.stringify(input.labels),
    input.summary?.trim() || summaryFor(input.name, input.body),
    input.body,
    input.details ?? null,
    actorSub,
    now,
    id,
  );
  if (unpublish) {
    await writePublishAudit(db, {
      libraryId: existing.library_id,
      itemId: id,
      actorSub,
      fromStatus: "published",
      toStatus: "draft",
    });
  }
  return getItem(db, id, { publishedOnly: false });
}

/** Make a draft visible to readers and the kiosk. Copies working fields into published_snapshot. */
export async function publishItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing || existing.status !== "draft") return undefined;
  const now = Date.now();
  const snapshot = snapshotFromItem({
    name: existing.name,
    labels: existing.labels,
    summary: existing.summary,
    body: existing.body,
    details: existing.details,
    published_at: now,
  });
  await runSql(
    db,
    `UPDATE items
     SET status = 'published', published_snapshot = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND status = 'draft'`,
    snapshot,
    actorSub,
    now,
    id,
  );
  await writePublishAudit(db, {
    libraryId: existing.library_id,
    itemId: id,
    actorSub,
    fromStatus: "draft",
    toStatus: "published",
  });
  return getItem(db, id, { publishedOnly: false });
}

/** Hide a published item from readers without archiving. Keeps last published snapshot. */
export async function unpublishItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing || existing.status !== "published") return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'draft', updated_by = ?, updated_at = ? WHERE id = ? AND status = 'published'`,
    actorSub,
    now,
    id,
  );
  await writePublishAudit(db, {
    libraryId: existing.library_id,
    itemId: id,
    actorSub,
    fromStatus: "published",
    toStatus: "draft",
  });
  return getItem(db, id, { publishedOnly: false });
}

/** Move a draft or published item out of active lists. Not visible to readers. */
export async function archiveItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing || existing.status === "archived") return undefined;
  const fromStatus = existing.status;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'archived', updated_by = ?, updated_at = ? WHERE id = ?`,
    actorSub,
    now,
    id,
  );
  await writePublishAudit(db, {
    libraryId: existing.library_id,
    itemId: id,
    actorSub,
    fromStatus,
    toStatus: "archived",
  });
  return getItem(db, id, { publishedOnly: false });
}

/** Bring an archived item back as a draft (still Pending until Publish). */
export async function restoreItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing || existing.status !== "archived") return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'draft', updated_by = ?, updated_at = ? WHERE id = ? AND status = 'archived'`,
    actorSub,
    now,
    id,
  );
  await writePublishAudit(db, {
    libraryId: existing.library_id,
    itemId: id,
    actorSub,
    fromStatus: "archived",
    toStatus: "draft",
  });
  return getItem(db, id, { publishedOnly: false });
}

export async function deleteItem(db: Database, id: string): Promise<boolean> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing) return false;
  await runSql(db, "DELETE FROM publish_audit WHERE item_id = ?", id);
  await runSql(db, "DELETE FROM items WHERE id = ?", id);
  return true;
}
