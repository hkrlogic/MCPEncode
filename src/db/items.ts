/** Item CRUD and status gate (draft / published / archived). */
import type { Database } from "./types.ts";
import type { ItemWriteInput, LibrarySchema } from "../items/library-schema.ts";
import { itemReview } from "../items/review.ts";
import {
  excerptOf,
  isValidEntityKey,
  normalizeEntityKey,
  type ItemInput,
  type ListQuery,
} from "../items/schema.ts";
import { parseTableValues } from "../items/table-proposal.ts";
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
  canRevertToPublished,
  libraryWhere,
  parseLabels,
  parsePublishedSnapshot,
  runSql,
  snapshotFromItem,
  summaryFor,
  toItem,
  type SqlItem,
  getRow,
} from "./query-helpers.ts";
import { defaultLibraryId, getLibrary, lockLibrary } from "./libraries.ts";

export type RevertToPublishedResult =
  | { ok: true; item: ItemRow }
  | {
      ok: false;
      reason: "not_found" | "archived" | "no_snapshot" | "no_changes" | "unreadable";
    };

type ListHit = {
  id: string;
  library_id: string;
  name: string;
  entity_key: string | null;
  labels: string | string[];
  summary: string;
  status: string;
  updated_at: number;
  /** Present only when the list asked for table column values or a Pending review. */
  details?: string | null;
  body?: string;
  published_snapshot?: string | null;
};

function toSummary(row: ListHit, options: { includeValues: boolean; review?: LibrarySchema }): ItemSummary {
  const labels = parseLabels(row.labels);
  const summary: ItemSummary = {
    id: row.id,
    library_id: row.library_id,
    name: row.name,
    entity_key: typeof row.entity_key === "string" && row.entity_key ? row.entity_key : null,
    labels,
    summary: excerptOf(row.summary),
    status: asStatus(row.status),
    updated_at: row.updated_at,
  };
  if (options.includeValues) {
    const values = parseTableValues(typeof row.details === "string" ? row.details : null);
    if (values) summary.values = values;
  }
  // Pending rows on the publisher list say what changed. MCP lists do not ask for this.
  if (options.review && summary.status === "draft") {
    summary.review = itemReview(
      {
        name: row.name,
        labels,
        summary: row.summary,
        body: row.body ?? "",
        details: typeof row.details === "string" ? row.details : null,
      },
      parsePublishedSnapshot(row.published_snapshot),
      options.review,
    );
  }
  return summary;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

/** Normalize and validate an optional entity key for storage. */
export function entityKeyForSave(raw: string | undefined | null): {
  ok: true;
  key: string | null;
} | { ok: false; message: string } {
  const key = normalizeEntityKey(raw);
  if (key == null) return { ok: true, key: null };
  if (!isValidEntityKey(key)) {
    return {
      ok: false,
      message:
        "Entity key must start with a letter or digit and use only letters, digits, and . _ : / -",
    };
  }
  return { ok: true, key };
}

export async function listItems(
  db: Database,
  query: ListQuery = {},
  scope: ReadScope = { publishedOnly: true },
  options: { includeDetails?: boolean; review?: LibrarySchema } = {},
): Promise<ItemSummary[]> {
  if (!query.library_id) {
    throw new Error("library_id is required");
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), LIST_LIMIT_MAX);
  const offset = Math.min(Math.max(query.offset ?? 0, 0), LIST_OFFSET_MAX);
  // Name, labels, summary, and optional exact entity_key. The body stays in the table.
  const where = [libraryWhere(scope)];
  const params: unknown[] = [query.library_id];
  const entityKey = normalizeEntityKey(query.entity_key);
  if (entityKey) {
    where.push("entity_key = ?");
    params.push(entityKey);
  }
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
  // details is the table-row JSON. The catalog list omits it; the library grid asks for it.
  // A Pending review also needs body and the last published copy, then drops them
  // after the comparison so the page does not receive the full text.
  const columns = options.review
    ? "id, library_id, name, entity_key, labels, summary, status, updated_at, body, details, published_snapshot"
    : options.includeDetails
      ? "id, library_id, name, entity_key, labels, summary, status, updated_at, details"
      : "id, library_id, name, entity_key, labels, summary, status, updated_at";
  const rows = await allRows<ListHit>(
    db,
    `SELECT ${columns}
     FROM items
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
  );
  return rows.map((row) =>
    toSummary(row, { includeValues: options.includeDetails === true, review: options.review }),
  );
}

/** Exact entity_key lookup inside one library. */
export async function getItemByEntityKey(
  db: Database,
  libraryId: string,
  entityKey: string,
  scope: ReadScope = { publishedOnly: true },
): Promise<ItemRow | undefined> {
  const key = normalizeEntityKey(entityKey);
  if (!key) return undefined;
  const statusClause = scope.publishedOnly ? "AND status = 'published'" : "";
  const row = await getRow<SqlItem>(
    db,
    `SELECT ${ITEM_COLUMNS} FROM items WHERE library_id = ? AND entity_key = ? ${statusClause} LIMIT 1`,
    libraryId,
    key,
  );
  return row ? toItem(row) : undefined;
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

type ItemSave = ItemInput & {
  summary?: string;
  details?: string | null;
  entity_key?: string | null;
};

export async function countLibraryItems(db: Database, libraryId: string): Promise<number> {
  const row = await getRow<{ n: string | number }>(
    db,
    "SELECT COUNT(*) AS n FROM items WHERE library_id = ?",
    libraryId,
  );
  return Number(row?.n ?? 0);
}

/**
 * Validate against the library schema and insert an item.
 * Review Lock libraries save as Pending; Review Unlock libraries save as Published.
 * Holds the library row lock so this cannot land under a schema that was
 * just replaced by table approval.
 */
export async function addDraftItem(
  db: Database,
  libraryId: string,
  input: ItemWriteInput,
  actorSub: string,
): Promise<{ ok: true; item: ItemRow } | { ok: false; message: string }> {
  try {
    return await db.transaction(async (tx) => {
      const library = await lockLibrary(tx, libraryId);
      if (!library) return { ok: false, message: "Library not found." };
      const saved = itemForLibrary(library.schema, input);
      if (!saved.ok) return saved;
      const status = library.writeMode === "direct" ? "published" : "draft";
      const item = await createItem(tx, saved.item, actorSub, libraryId, { status });
      return { ok: true, item };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        message:
          "An item with this entity_key already exists in this library. Call list_items with entity_key, then update_item that id.",
      };
    }
    throw error;
  }
}

export async function createItem(
  db: Database,
  input: ItemSave,
  actorSub: string,
  libraryId?: string,
  options: { status?: "draft" | "published" } = {},
): Promise<ItemRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const library_id = libraryId || (await defaultLibraryId(db));
  if (!library_id) throw new Error("library_id is required");
  const keyed =
    input.entity_key === undefined ? { ok: true as const, key: null } : entityKeyForSave(input.entity_key);
  if (!keyed.ok) throw new Error(keyed.message);
  const status = options.status === "published" ? "published" : "draft";
  const summary = input.summary?.trim() || summaryFor(input.name, input.body);
  const snapshot =
    status === "published"
      ? snapshotFromItem({
          name: input.name,
          labels: input.labels,
          summary,
          body: input.body,
          details: input.details ?? null,
          published_at: now,
        })
      : null;
  await runSql(
    db,
    `INSERT INTO items (
       id, library_id, name, entity_key, labels, summary, body, details, status, published_snapshot,
       created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    library_id,
    input.name,
    keyed.key,
    JSON.stringify(input.labels),
    summary,
    input.body,
    input.details ?? null,
    status,
    snapshot,
    actorSub,
    actorSub,
    now,
    now,
  );
  if (status === "published") {
    await writePublishAudit(db, {
      libraryId: library_id,
      itemId: id,
      actorSub,
      fromStatus: "draft",
      toStatus: "published",
    });
  }
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
  const library = await getLibrary(db, existing.library_id);
  const writeMode = library?.writeMode ?? "reviewed";
  const now = Date.now();
  const summary = input.summary?.trim() || summaryFor(input.name, input.body);
  // Omit entity_key on update keeps the existing key; null/empty clears it.
  const keyed =
    input.entity_key === undefined
      ? { ok: true as const, key: existing.entity_key }
      : entityKeyForSave(input.entity_key);
  if (!keyed.ok) throw new Error(keyed.message);

  if (writeMode === "direct") {
    // Review Unlock: any successful save is live. Snapshot tracks the live copy.
    const fromStatus = existing.status;
    const snapshot = snapshotFromItem({
      name: input.name,
      labels: input.labels,
      summary,
      body: input.body,
      details: input.details ?? null,
      published_at: now,
    });
    try {
      await runSql(
        db,
        `UPDATE items
         SET name = ?, entity_key = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
             status = 'published', published_snapshot = ?,
             updated_by = ?, updated_at = ?
         WHERE id = ?`,
        input.name,
        keyed.key,
        JSON.stringify(input.labels),
        summary,
        input.body,
        input.details ?? null,
        snapshot,
        actorSub,
        now,
        id,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(
          "An item with this entity_key already exists in this library. Use that item’s id, or choose a different entity_key.",
        );
      }
      throw error;
    }
    if (fromStatus !== "published") {
      await writePublishAudit(db, {
        libraryId: existing.library_id,
        itemId: id,
        actorSub,
        fromStatus,
        toStatus: "published",
      });
    }
    return getItem(db, id, { publishedOnly: false });
  }

  // Review Lock: editing a published item moves it back to Pending.
  const unpublish = existing.status === "published";
  try {
    await runSql(
      db,
      `UPDATE items
       SET name = ?, entity_key = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
           status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
           updated_by = ?, updated_at = ?
       WHERE id = ?`,
      input.name,
      keyed.key,
      JSON.stringify(input.labels),
      summary,
      input.body,
      input.details ?? null,
      actorSub,
      now,
      id,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(
        "An item with this entity_key already exists in this library. Use that item’s id, or choose a different entity_key.",
      );
    }
    throw error;
  }
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

/**
 * Replace working fields with published_snapshot. Leaves snapshot unchanged.
 * Always ends as Pending (draft). Does not change entity_key.
 * Not the same as restoreItem (un-archive).
 */
export async function revertToPublished(
  db: Database,
  id: string,
  actorSub: string,
): Promise<RevertToPublishedResult> {
  return db.transaction(async (tx) => {
    const locked = await getRow<{ id: string }>(
      tx,
      "SELECT id FROM items WHERE id = ? FOR UPDATE",
      id,
    );
    if (!locked) return { ok: false, reason: "not_found" };
    const existing = await getItem(tx, id, { publishedOnly: false });
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.status === "archived") return { ok: false, reason: "archived" };
    // Snapshot JSON on the row may be present but unreadable → treat as missing.
    if (existing.published_snapshot == null) {
      const raw = await getRow<{ published_snapshot: string | null }>(
        tx,
        "SELECT published_snapshot FROM items WHERE id = ?",
        id,
      );
      if (raw?.published_snapshot) return { ok: false, reason: "unreadable" };
      return { ok: false, reason: "no_snapshot" };
    }
    if (!canRevertToPublished(existing)) return { ok: false, reason: "no_changes" };

    const snapshot = existing.published_snapshot;
    const fromStatus = existing.status;
    const now = Date.now();
    await runSql(
      tx,
      `UPDATE items
       SET name = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
           status = 'draft', updated_by = ?, updated_at = ?
       WHERE id = ?`,
      snapshot.name,
      JSON.stringify(snapshot.labels),
      snapshot.summary,
      snapshot.body,
      snapshot.details,
      actorSub,
      now,
      id,
    );
    if (fromStatus === "published") {
      await writePublishAudit(tx, {
        libraryId: existing.library_id,
        itemId: id,
        actorSub,
        fromStatus: "published",
        toStatus: "draft",
      });
    }
    const item = await getItem(tx, id, { publishedOnly: false });
    if (!item) return { ok: false, reason: "not_found" };
    return { ok: true, item };
  });
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
