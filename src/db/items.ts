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
import { writeAudit, writePublishAudit } from "./audit.ts";
import {
  allRows,
  asStatus,
  escapeLike,
  itemColumns,
  itemSource,
  readsLive,
  LIST_LIMIT_MAX,
  LIST_OFFSET_MAX,
  libraryWhere,
  parseLabels,
  parsePublishedSnapshot,
  previousSnapshotAfterPublish,
  revertPlan,
  runSql,
  snapshotFromItem,
  summaryFor,
  toItem,
  type SqlItem,
  getRow,
} from "./query-helpers.ts";
import { defaultLibraryId, getLibrary, lockLibrary } from "./libraries.ts";

export type RevertToPublishedResult =
  | { ok: true; item: ItemRow; kind: "published" | "previous" }
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
  published_live?: boolean | null;
  has_pending_changes?: boolean | null;
};

function toSummary(
  row: ListHit,
  options: { includeValues: boolean; review?: LibrarySchema; pendingFlag?: boolean },
): ItemSummary {
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
  if (options.pendingFlag) {
    summary.has_pending_changes = row.published_live === true || row.has_pending_changes === true;
  }
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

/** Readers never learn that an edit is Pending. */
function forScope(item: ItemRow, scope: ReadScope): ItemRow {
  if (!scope.publishedOnly) return item;
  const { has_pending_changes: _pending, ...rest } = item;
  return rest;
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
  const live = readsLive(scope);
  // Readers never learn that an edit is Pending; editors do.
  const pendingColumn = scope.publishedOnly ? "" : live ? ", has_pending_changes" : ", published_live";
  const base = "id, library_id, name, entity_key, labels, summary, status, updated_at";
  const columns =
    (options.review
      ? `${base}, body, details, published_snapshot`
      : options.includeDetails
        ? `${base}, details`
        : base) + pendingColumn;
  const rows = await allRows<ListHit>(
    db,
    `SELECT ${columns}
     FROM ${itemSource(scope)}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
  );
  return rows.map((row) =>
    toSummary(row, {
      includeValues: options.includeDetails === true,
      review: options.review,
      pendingFlag: !scope.publishedOnly,
    }),
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
    `SELECT ${itemColumns(scope)} FROM ${itemSource(scope)} WHERE library_id = ? AND entity_key = ? ${statusClause} LIMIT 1`,
    libraryId,
    key,
  );
  return row ? forScope(toItem(row), scope) : undefined;
}

/**
 * Read one item by id. When a library is named the item must belong to it,
 * whatever the caller's role: an id from another library is "not found".
 * The reader path always names one.
 */
export async function getItem(
  db: Database,
  id: string,
  scope: ReadScope & { libraryId?: string } = { publishedOnly: true },
): Promise<ItemRow | undefined> {
  if (scope.publishedOnly && !scope.libraryId) {
    throw new Error("library_id is required");
  }
  const statusClause = scope.publishedOnly ? " AND status = 'published'" : "";
  const columns = itemColumns(scope);
  const source = itemSource(scope);
  const row = scope.libraryId
    ? await getRow<SqlItem>(
        db,
        `SELECT ${columns} FROM ${source} WHERE id = ? AND library_id = ?${statusClause}`,
        id,
        scope.libraryId,
      )
    : await getRow<SqlItem>(db, `SELECT ${columns} FROM ${source} WHERE id = ?`, id);
  return row ? forScope(toItem(row), scope) : undefined;
}

/**
 * Read one item inside one library. MCP tools use this only: a Connect link
 * is scoped to its library, so an id from another library is never returned.
 */
export async function getLibraryItem(
  db: Database,
  libraryId: string,
  id: string,
  scope: ReadScope,
): Promise<ItemRow | undefined> {
  if (!libraryId) throw new Error("library_id is required");
  return getItem(db, id, { publishedOnly: scope.publishedOnly, live: scope.live, libraryId });
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

/** Message for a save that lost a race with another save. */
export const ITEM_CONFLICT_MESSAGE =
  "Conflict: this item changed since you read it, so this edit was not saved. Read it again (open_item version \"draft\"), reapply your change, and pass the new revision as expected_revision.";

/** The guarded UPDATE matched no row: a newer save won, or the item is gone. */
async function conflictOrMissing(
  db: Database,
  id: string,
  expected: number | undefined,
): Promise<undefined> {
  if (expected === undefined) return undefined;
  const current = await getItem(db, id, { publishedOnly: false });
  if (current) throw new ItemConflictError(current.updated_at);
  return undefined;
}

/** update_item was given an expected revision that is no longer current. */
export class ItemConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super(ITEM_CONFLICT_MESSAGE);
    this.name = "ItemConflictError";
    this.currentRevision = currentRevision;
  }
}

export async function updateItem(
  db: Database,
  id: string,
  input: ItemSave,
  actorSub: string,
  /**
   * libraryId: the item must belong to this library or nothing is changed.
   * expectedRevision: the working row's updated_at the caller last read. When
   * set and no longer current, nothing is saved and ItemConflictError is thrown.
   */
  scope: { libraryId?: string; expectedRevision?: number } = {},
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false, libraryId: scope.libraryId });
  if (!existing) return undefined;
  const expected = scope.expectedRevision;
  if (expected !== undefined && existing.updated_at !== expected) {
    throw new ItemConflictError(existing.updated_at);
  }
  // Same check inside the UPDATE, so two saves that both passed the read above
  // cannot both win.
  const guard = expected === undefined ? "" : " AND updated_at = ?";
  const guardParams = expected === undefined ? [] : [expected];
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
    // Keep the prior published copy so Revert can undo an accidental save.
    const fromStatus = existing.status;
    const nextFields = {
      name: input.name,
      labels: input.labels,
      summary,
      body: input.body,
      details: input.details ?? null,
    };
    const snapshot = snapshotFromItem({ ...nextFields, published_at: now });
    let changed: { id: string }[] = [];
    const previous = previousSnapshotAfterPublish(
      existing.published_snapshot,
      nextFields,
      existing.previous_published_snapshot,
    );
    try {
      changed = await allRows<{ id: string }>(
        db,
        `UPDATE items
         SET name = ?, entity_key = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
             status = 'published', published_snapshot = ?, previous_published_snapshot = ?,
             published_live = false, updated_by = ?, updated_at = ?
         WHERE id = ? AND library_id = ?${guard}
         RETURNING id`,
        input.name,
        keyed.key,
        JSON.stringify(input.labels),
        summary,
        input.body,
        input.details ?? null,
        snapshot,
        previous ? JSON.stringify(previous) : null,
        actorSub,
        now,
        id,
        existing.library_id,
        ...guardParams,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(
          "An item with this entity_key already exists in this library. Use that item’s id, or choose a different entity_key.",
        );
      }
      throw error;
    }
    if (changed.length === 0) return conflictOrMissing(db, id, expected);
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

  // Review Lock: editing a published item moves the edit to Pending. Its last
  // published copy stays live for Readers and agents until Publish or Cancel.
  const unpublish = existing.status === "published";
  const keepLive = unpublish && existing.published_snapshot !== null;
  let changed: { id: string }[] = [];
  try {
    changed = await allRows<{ id: string }>(
      db,
      `UPDATE items
       SET name = ?, entity_key = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
           status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
           published_live = CASE WHEN status = 'published' THEN ? ELSE published_live END,
           updated_by = ?, updated_at = ?
       WHERE id = ? AND library_id = ?${guard}
       RETURNING id`,
      input.name,
      keyed.key,
      JSON.stringify(input.labels),
      summary,
      input.body,
      input.details ?? null,
      keepLive,
      actorSub,
      now,
      id,
      existing.library_id,
      ...guardParams,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(
        "An item with this entity_key already exists in this library. Use that item’s id, or choose a different entity_key.",
      );
    }
    throw error;
  }
  if (changed.length === 0) return conflictOrMissing(db, id, expected);
  if (unpublish) {
    await writePublishAudit(db, {
      libraryId: existing.library_id,
      itemId: id,
      actorSub,
      fromStatus: "published",
      toStatus: "draft",
    });
    if (keepLive) {
      await writeAudit(db, {
        actorSub,
        libraryId: existing.library_id,
        tool: "item.edit_pending",
        success: true,
        detail: id,
      });
    }
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

/**
 * Make a draft visible to readers and the kiosk.
 * Copies working fields into published_snapshot; keeps the prior snapshot for Revert.
 */
export async function publishItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (existing?.status !== "draft") return undefined;
  const now = Date.now();
  const nextFields = {
    name: existing.name,
    labels: existing.labels,
    summary: existing.summary,
    body: existing.body,
    details: existing.details,
  };
  const snapshot = snapshotFromItem({ ...nextFields, published_at: now });
  const previous = previousSnapshotAfterPublish(
    existing.published_snapshot,
    nextFields,
    existing.previous_published_snapshot,
  );
  await runSql(
    db,
    `UPDATE items
     SET status = 'published', published_snapshot = ?, previous_published_snapshot = ?,
         published_live = false, updated_by = ?, updated_at = ?
     WHERE id = ? AND status = 'draft'`,
    snapshot,
    previous ? JSON.stringify(previous) : null,
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
  await writeAudit(db, {
    actorSub,
    libraryId: existing.library_id,
    tool: existing.has_pending_changes ? "item.publish_replace_live" : "item.publish",
    success: true,
    detail: id,
  });
  return getItem(db, id, { publishedOnly: false });
}

export type CancelPublishResult =
  | { ok: true; item: ItemRow; kind: "restored" | "archived" }
  | { ok: false; reason: "not_found" | "not_pending" | "unreadable" };

/**
 * Withdraw a Pending item.
 * If it was published before, working fields return to that snapshot and it is live again.
 * If it was never published, it moves to Archives. Snapshots and entity_key stay put.
 */
export async function cancelPublishItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<CancelPublishResult> {
  return db.transaction(async (tx) => {
    const locked = await getRow<{ id: string; published_snapshot: string | null }>(
      tx,
      "SELECT id, published_snapshot FROM items WHERE id = ? FOR UPDATE",
      id,
    );
    if (!locked) return { ok: false, reason: "not_found" };
    const existing = await getItem(tx, id, { publishedOnly: false });
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.status !== "draft") return { ok: false, reason: "not_pending" };

    const now = Date.now();
    if (existing.published_snapshot) {
      const snapshot = existing.published_snapshot;
      await runSql(
        tx,
        `UPDATE items
         SET name = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
             status = 'published', published_live = false, updated_by = ?, updated_at = ?
         WHERE id = ? AND status = 'draft'`,
        snapshot.name,
        JSON.stringify(snapshot.labels),
        snapshot.summary,
        snapshot.body,
        snapshot.details,
        actorSub,
        now,
        id,
      );
      await writePublishAudit(tx, {
        libraryId: existing.library_id,
        itemId: id,
        actorSub,
        fromStatus: "draft",
        toStatus: "published",
      });
      await writeAudit(tx, {
        actorSub,
        libraryId: existing.library_id,
        tool: "item.discard_pending",
        success: true,
        detail: id,
      });
      const item = await getItem(tx, id, { publishedOnly: false });
      if (!item) return { ok: false, reason: "not_found" };
      return { ok: true, item, kind: "restored" };
    }

    // A stored snapshot we cannot read must not be archived as if it never existed.
    if (locked.published_snapshot) return { ok: false, reason: "unreadable" };

    await runSql(
      tx,
      `UPDATE items SET status = 'archived', published_live = false, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      actorSub,
      now,
      id,
    );
    await writePublishAudit(tx, {
      libraryId: existing.library_id,
      itemId: id,
      actorSub,
      fromStatus: "draft",
      toStatus: "archived",
    });
    const item = await getItem(tx, id, { publishedOnly: false });
    if (!item) return { ok: false, reason: "not_found" };
    return { ok: true, item, kind: "archived" };
  });
}

/**
 * Cancel many Pending items in one library.
 * Skips ids that are missing, in another library, or not Pending.
 */
export async function cancelPublishItems(
  db: Database,
  libraryId: string,
  ids: string[],
  actorSub: string,
): Promise<{ restored: string[]; archived: string[]; unreadable: string[] }> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, LIST_LIMIT_MAX);
  const restored: string[] = [];
  const archived: string[] = [];
  const unreadable: string[] = [];
  for (const id of unique) {
    const existing = await getItem(db, id, { publishedOnly: false });
    if (!existing || existing.library_id !== libraryId || existing.status !== "draft") continue;
    const result = await cancelPublishItem(db, id, actorSub);
    if (!result.ok) {
      if (result.reason === "unreadable") unreadable.push(id);
      continue;
    }
    if (result.kind === "restored") restored.push(result.item.id);
    else archived.push(result.item.id);
  }
  return { restored, archived, unreadable };
}

/** Hide a published item from readers without archiving. Keeps last published snapshot. */
export async function unpublishItem(
  db: Database,
  id: string,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (existing?.status !== "published") return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'draft', published_live = false, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'published'`,
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
    `UPDATE items SET status = 'archived', published_live = false, updated_by = ?, updated_at = ? WHERE id = ?`,
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
  if (existing?.status !== "archived") return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'draft', published_live = false, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'archived'`,
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
 * Replace working fields with the revert plan snapshot (current or previous).
 * Leaves published_snapshot and previous_published_snapshot unchanged so readers
 * keep seeing the current published copy until Publish.
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

    const plan = revertPlan(existing);
    if (!plan) {
      // Distinguish never-published from “nothing to undo” for the UI message.
      if (existing.published_snapshot == null && existing.previous_published_snapshot == null) {
        const raw = await getRow<{
          published_snapshot: string | null;
          previous_published_snapshot: string | null;
        }>(
          tx,
          "SELECT published_snapshot, previous_published_snapshot FROM items WHERE id = ?",
          id,
        );
        if (raw?.published_snapshot || raw?.previous_published_snapshot) {
          return { ok: false, reason: "unreadable" };
        }
        return { ok: false, reason: "no_snapshot" };
      }
      return { ok: false, reason: "no_changes" };
    }

    const snapshot = plan.snapshot;
    const fromStatus = existing.status;
    const now = Date.now();
    await runSql(
      tx,
      `UPDATE items
       SET name = ?, labels = ?::jsonb, summary = ?, body = ?, details = ?,
           status = 'draft', published_live = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      snapshot.name,
      JSON.stringify(snapshot.labels),
      snapshot.summary,
      snapshot.body,
      snapshot.details,
      // The current published copy stays live; only the working fields change.
      (fromStatus === "published" || existing.has_pending_changes) && existing.published_snapshot !== null,
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
    await writeAudit(tx, {
      actorSub,
      libraryId: existing.library_id,
      tool: "item.revert_pending",
      success: true,
      detail: `${id} kind=${plan.kind}`,
    });
    const item = await getItem(tx, id, { publishedOnly: false });
    if (!item) return { ok: false, reason: "not_found" };
    return { ok: true, item, kind: plan.kind };
  });
}

export async function deleteItem(
  db: Database,
  id: string,
  /** When set, the item must belong to this library or nothing is deleted. */
  scope: { libraryId?: string } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existing = await getItem(tx, id, { publishedOnly: false, libraryId: scope.libraryId });
    if (!existing) return false;
    await runSql(tx, "DELETE FROM publish_audit WHERE item_id = ?", id);
    await runSql(tx, "DELETE FROM items WHERE id = ? AND library_id = ?", id, existing.library_id);
    return true;
  });
}
