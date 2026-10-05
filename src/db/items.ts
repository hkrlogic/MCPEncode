/** Item CRUD and status gate (draft / published / archived). */
import type { Database } from "./types.ts";
import type { ItemWriteInput } from "../items/library-schema.ts";
import { excerptOf, type ItemInput, type ListQuery } from "../items/schema.ts";
import { itemForLibrary } from "../items/templates.ts";
import type { ItemRow, ItemSummary, ReadScope } from "./models.ts";
import { writePublishAudit } from "./audit.ts";
import {
  allRows,
  asStatus,
  escapeLike,
  ITEM_COLUMNS,
  LIST_LIMIT_MAX,
  LIST_OFFSET_MAX,
  libraryWhere,
  parseLabels,
  runSql,
  snapshotFromItem,
  summaryFor,
  toItem,
  type SqlItem,
  getRow,
} from "./query-helpers.ts";
import { defaultLibraryId, lockLibrary } from "./libraries.ts";

type ListHit = {
  id: string;
  library_id: string;
  name: string;
  labels: string | string[];
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
  const limit = Math.min(Math.max(query.limit ?? 50, 1), LIST_LIMIT_MAX);
  const offset = Math.min(Math.max(query.offset ?? 0, 0), LIST_OFFSET_MAX);
  // Name, labels, and summary only. The body stays in the table.
  const where = [libraryWhere(scope)];
  const params: unknown[] = [query.library_id];
  const label = query.label?.trim().toLowerCase();
  if (label) {
    where.push("labels @> ?::jsonb");
    params.push(JSON.stringify([label]));
  }
  const needle = query.q?.trim();
  if (needle) {
    const pattern = `%${escapeLike(needle)}%`;
    where.push("(name ILIKE ? ESCAPE '\\' OR summary ILIKE ? ESCAPE '\\' OR labels::text ILIKE ? ESCAPE '\\')");
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
        `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ? AND library_id = ? AND status = 'published'`,
        id,
        scope.libraryId,
      )
    : await getRow<SqlItem>(db, `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id);
  return row ? toItem(row) : undefined;
}

type ItemSave = ItemInput & { summary?: string; details?: string | null };

export async function countLibraryItems(db: Database, libraryId: string): Promise<number> {
  const row = await getRow<{ n: string | number }>(
    db,
    "SELECT COUNT(*) AS n FROM items WHERE library_id = ?",
    libraryId,
  );
  return Number(row?.n ?? 0);
}

/**
 * Validate against the library schema and insert a draft.
 * Holds the library row lock so this cannot land under a schema that was
 * just replaced by table approval.
 */
export async function addDraftItem(
  db: Database,
  libraryId: string,
  input: ItemWriteInput,
  actorSub: string,
): Promise<{ ok: true; item: ItemRow } | { ok: false; message: string }> {
  return db.transaction(async (tx) => {
    const library = await lockLibrary(tx, libraryId);
    if (!library) return { ok: false, message: "Library not found." };
    const saved = itemForLibrary(library.schema, input);
    if (!saved.ok) return saved;
    const item = await createItem(tx, saved.item, actorSub, libraryId);
    return { ok: true, item };
  });
}

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
     ) VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
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
     SET name = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
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

/**
 * Publish many Pending items in one library.
 * Skips ids that are missing, in another library, or not drafts.
 */
export async function publishItems(
  db: Database,
  libraryId: string,
  ids: string[],
  actorSub: string,
): Promise<string[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, LIST_LIMIT_MAX);
  const published: string[] = [];
  for (const id of unique) {
    const existing = await getItem(db, id, { publishedOnly: false });
    if (!existing || existing.library_id !== libraryId || existing.status !== "draft") continue;
    const row = await publishItem(db, id, actorSub);
    if (row) published.push(row.id);
  }
  return published;
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
  return db.transaction(async (tx) => {
    const existing = await getItem(tx, id, { publishedOnly: false });
    if (!existing) return false;
    await runSql(tx, "DELETE FROM publish_audit WHERE item_id = ?", id);
    await runSql(tx, "DELETE FROM items WHERE id = ?", id);
    return true;
  });
}
