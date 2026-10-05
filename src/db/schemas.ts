/** Per-library schema drafts and published versions. */
import type { Database } from "./types.ts";
import {
  parseLibrarySchemaDoc,
  stringifyLibrarySchemaDoc,
  type LibrarySchemaDoc,
} from "../items/library-schema.ts";
import { getRow, runSql } from "./query-helpers.ts";

export type LibrarySchemaStatus = "draft" | "published";

export type LibrarySchemaRow = {
  library_id: string;
  version: number;
  status: LibrarySchemaStatus;
  fields: LibrarySchemaDoc;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

type SqlSchema = {
  library_id: string;
  version: number;
  status: string;
  fields_json: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

function toRow(row: SqlSchema): LibrarySchemaRow {
  return {
    library_id: row.library_id,
    version: Number(row.version),
    status: row.status === "published" ? "published" : "draft",
    fields: parseLibrarySchemaDoc(row.fields_json),
    updated_by: row.updated_by,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Latest published schema for a library, if any. */
export async function getPublishedSchema(
  db: Database,
  libraryId: string,
): Promise<LibrarySchemaRow | undefined> {
  const row = await getRow<SqlSchema>(
    db,
    `SELECT * FROM library_schemas
     WHERE library_id = ? AND status = 'published'
     ORDER BY version DESC
     LIMIT 1`,
    libraryId,
  );
  return row ? toRow(row) : undefined;
}

/** Working draft schema (highest draft version), if any. */
export async function getDraftSchema(
  db: Database,
  libraryId: string,
): Promise<LibrarySchemaRow | undefined> {
  const row = await getRow<SqlSchema>(
    db,
    `SELECT * FROM library_schemas
     WHERE library_id = ? AND status = 'draft'
     ORDER BY version DESC
     LIMIT 1`,
    libraryId,
  );
  return row ? toRow(row) : undefined;
}

/**
 * Schema shown in the UI editor: draft if present, else a copy of the latest published,
 * else an empty draft document (not yet persisted).
 */
export async function getEditableSchema(
  db: Database,
  libraryId: string,
): Promise<LibrarySchemaRow | { library_id: string; version: number; status: "draft"; fields: LibrarySchemaDoc; ephemeral: true }> {
  const draft = await getDraftSchema(db, libraryId);
  if (draft) return draft;
  const published = await getPublishedSchema(db, libraryId);
  if (published) {
    return {
      library_id: libraryId,
      version: published.version + 1,
      status: "draft",
      fields: published.fields,
      ephemeral: true,
    };
  }
  return {
    library_id: libraryId,
    version: 1,
    status: "draft",
    fields: { fields: [] },
    ephemeral: true,
  };
}

/** Save (upsert) the draft schema for a library. */
export async function saveDraftSchema(
  db: Database,
  libraryId: string,
  doc: LibrarySchemaDoc,
  actorSub: string,
): Promise<LibrarySchemaRow> {
  const now = Date.now();
  const existing = await getDraftSchema(db, libraryId);
  const published = await getPublishedSchema(db, libraryId);
  const version = existing?.version ?? (published ? published.version + 1 : 1);
  const json = stringifyLibrarySchemaDoc(doc);

  if (existing) {
    await runSql(
      db,
      `UPDATE library_schemas
       SET fields_json = ?, updated_by = ?, updated_at = ?
       WHERE library_id = ? AND version = ? AND status = 'draft'`,
      json,
      actorSub,
      now,
      libraryId,
      version,
    );
  } else {
    await runSql(
      db,
      `INSERT INTO library_schemas (
         library_id, version, status, fields_json, updated_by, created_at, updated_at
       ) VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
      libraryId,
      version,
      json,
      actorSub,
      now,
      now,
    );
  }
  const saved = await getDraftSchema(db, libraryId);
  if (!saved) throw new Error("failed to read schema after save");
  return saved;
}

/**
 * Publish the current draft (or save+publish doc). Marks prior published rows as superseded
 * by inserting a new published version from the draft.
 */
export async function publishSchema(
  db: Database,
  libraryId: string,
  actorSub: string,
  doc?: LibrarySchemaDoc,
): Promise<LibrarySchemaRow> {
  if (doc) {
    await saveDraftSchema(db, libraryId, doc, actorSub);
  }
  const draft = await getDraftSchema(db, libraryId);
  if (!draft) {
    throw new Error("Save a draft schema before publishing");
  }
  if (draft.fields.fields.length === 0) {
    throw new Error("Add at least one field before publishing the schema");
  }
  const now = Date.now();
  // Demote any currently published version back to draft history marker:
  // keep row but flip status — only one published allowed via app queries (latest published).
  // Simpler: delete old published? Keep history: set old published to stay as published versions
  // and only the latest published wins in getPublishedSchema (ORDER BY version DESC).
  await runSql(
    db,
    `UPDATE library_schemas
     SET status = 'published', updated_by = ?, updated_at = ?
     WHERE library_id = ? AND version = ? AND status = 'draft'`,
    actorSub,
    now,
    libraryId,
    draft.version,
  );
  const published = await getPublishedSchema(db, libraryId);
  if (!published) throw new Error("failed to read schema after publish");
  return published;
}
