/**
 * Files stored on an item. List and Connect see names only.
 * The download path is the only query that reads bytes.
 */
import crypto from "node:crypto";
import { writePublishAudit } from "./audit.ts";
import { getLibrary } from "./libraries.ts";
import type { ItemStatus } from "./models.ts";
import { getRow, runSql } from "./query-helpers.ts";
import type { Database } from "./types.ts";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_ITEM,
  sniffFileType,
  sanitizeFileName,
  type FileContentType,
} from "../items/files.ts";

/** Name and type for the item page and for Connect. No bytes. */
export type ItemFileMeta = {
  id: string;
  item_id: string;
  name: string;
  content_type: FileContentType;
  byte_size: number;
  created_at: number;
};

export type ItemFile = ItemFileMeta & { bytes: Buffer };

type FileRow = {
  id: string;
  item_id: string;
  name: string;
  content_type: string;
  byte_size: number;
  created_at: number;
};

const META_COLUMNS = "id, item_id, name, content_type, byte_size, created_at";

function asContentType(value: string): FileContentType | undefined {
  if (
    value === "application/pdf" ||
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp"
  ) {
    return value;
  }
  return undefined;
}

function toMeta(row: FileRow): ItemFileMeta | undefined {
  const content_type = asContentType(row.content_type);
  if (!content_type) return undefined;
  return {
    id: row.id,
    item_id: row.item_id,
    name: row.name,
    content_type,
    byte_size: Number(row.byte_size),
    created_at: Number(row.created_at),
  };
}

export type AddFileResult =
  | { ok: true; file: ItemFileMeta; pending: boolean }
  | { ok: false; code: "not_found" | "too_many" | "empty" | "too_big" | "type" };

/**
 * Store one file on an item.
 * Review Lock: a file on a published item moves that item back to Pending.
 */
export async function addItemFile(
  db: Database,
  itemId: string,
  input: { filename: string; bytes: Buffer },
  actorSub: string,
): Promise<AddFileResult> {
  if (input.bytes.length === 0) return { ok: false, code: "empty" };
  if (input.bytes.length > MAX_FILE_BYTES) return { ok: false, code: "too_big" };
  const contentType = sniffFileType(input.bytes);
  if (!contentType) return { ok: false, code: "type" };
  const name = sanitizeFileName(input.filename, contentType);

  return db.transaction(async (tx) => {
    const locked = await getRow<{ id: string; library_id: string; status: string }>(
      tx,
      "SELECT id, library_id, status FROM items WHERE id = ? FOR UPDATE",
      itemId,
    );
    if (!locked) return { ok: false, code: "not_found" };
    const countRow = await getRow<{ n: number }>(
      tx,
      "SELECT COUNT(*) AS n FROM item_files WHERE item_id = ?",
      itemId,
    );
    if (Number(countRow?.n ?? 0) >= MAX_FILES_PER_ITEM) return { ok: false, code: "too_many" };

    const id = crypto.randomUUID();
    const now = Date.now();
    await runSql(
      tx,
      `INSERT INTO item_files (id, item_id, name, content_type, byte_size, bytes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      itemId,
      name,
      contentType,
      input.bytes.length,
      input.bytes,
      actorSub,
      now,
    );
    const pending = await holdPublishedForReview(tx, locked.library_id, itemId, locked.status, actorSub);
    const file: ItemFileMeta = {
      id,
      item_id: itemId,
      name,
      content_type: contentType,
      byte_size: input.bytes.length,
      created_at: now,
    };
    return { ok: true, file, pending };
  });
}

export async function listItemFiles(db: Database, itemId: string): Promise<ItemFileMeta[]> {
  const rows = (await db.all(
    `SELECT ${META_COLUMNS} FROM item_files WHERE item_id = ? ORDER BY created_at ASC, id ASC`,
    itemId,
  )) as FileRow[];
  return rows.flatMap((row) => {
    const meta = toMeta(row);
    return meta ? [meta] : [];
  });
}

/** Bytes for one file on this item. Undefined when the id belongs to another item. */
export async function getItemFile(
  db: Database,
  itemId: string,
  fileId: string,
): Promise<ItemFile | undefined> {
  const row = await getRow<FileRow & { bytes: Buffer | string }>(
    db,
    `SELECT ${META_COLUMNS}, bytes FROM item_files WHERE item_id = ? AND id = ?`,
    itemId,
    fileId,
  );
  if (!row) return undefined;
  const meta = toMeta(row);
  if (!meta) return undefined;
  const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
  return { ...meta, bytes };
}

export type RemoveFileResult =
  | { ok: true; pending: boolean }
  | { ok: false; code: "not_found" };

/** Remove one file. Review Lock moves a published item back to Pending. */
export async function removeItemFile(
  db: Database,
  itemId: string,
  fileId: string,
  actorSub: string,
): Promise<RemoveFileResult> {
  return db.transaction(async (tx) => {
    const locked = await getRow<{ id: string; library_id: string; status: string }>(
      tx,
      "SELECT id, library_id, status FROM items WHERE id = ? FOR UPDATE",
      itemId,
    );
    if (!locked) return { ok: false, code: "not_found" };
    const existing = await getRow<{ id: string }>(
      tx,
      "SELECT id FROM item_files WHERE item_id = ? AND id = ?",
      itemId,
      fileId,
    );
    if (!existing) return { ok: false, code: "not_found" };
    await runSql(tx, "DELETE FROM item_files WHERE item_id = ? AND id = ?", itemId, fileId);
    const pending = await holdPublishedForReview(tx, locked.library_id, itemId, locked.status, actorSub);
    return { ok: true, pending };
  });
}

/**
 * Review Lock moves a published item to Pending when its files change. The
 * published text stays live; files are not versioned, so Readers see the
 * current file list (documented in known-limitations).
 */
async function holdPublishedForReview(
  db: Database,
  libraryId: string,
  itemId: string,
  status: string,
  actorSub: string,
): Promise<boolean> {
  if (status !== "published") return false;
  const library = await getLibrary(db, libraryId);
  if (library?.writeMode !== "reviewed") return false;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items SET status = 'draft', published_live = (published_snapshot IS NOT NULL), updated_by = ?, updated_at = ? WHERE id = ? AND status = 'published'`,
    actorSub,
    now,
    itemId,
  );
  await writePublishAudit(db, {
    libraryId,
    itemId,
    actorSub,
    fromStatus: "published" satisfies ItemStatus,
    toStatus: "draft",
  });
  return true;
}
