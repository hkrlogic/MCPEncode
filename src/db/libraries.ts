/** Library CRUD and name/id resolution for lookups. */
import { randomBytes } from "node:crypto";
import type { Database } from "./types.ts";
import { librarySchemaOf, schemaForStarter, type LibrarySchema } from "../items/library-schema.ts";
import { isLibraryWriteMode, libraryInputSchema, type LibraryWriteMode } from "../items/schema.ts";
import { parseStoredFieldProposal } from "../items/field-proposal.ts";
import { parseStoredTableProposal, type TableProposal, type TableProposalDraft } from "../items/table-proposal.ts";
import { isLibraryTemplate, type LibraryTemplate } from "../items/templates.ts";
import { generateReaderKey, hashReaderKey, readerKeyPrefix } from "../auth/reader-key.ts";
import { grantLibraryAccess } from "./access.ts";
import type { LibraryRow } from "./models.ts";
import { allRows, escapeLike, getRow, runSql } from "./query-helpers.ts";

function libraryTemplate(value: string | undefined): LibraryTemplate {
  return value && isLibraryTemplate(value) ? value : "general";
}

function libraryWriteMode(value: string | undefined): LibraryWriteMode {
  return value && isLibraryWriteMode(value) ? value : "reviewed";
}

/** Secret path segment for the library MCP URL (base64url, 32 bytes). */
function freshConnectToken(): string {
  return randomBytes(32).toString("base64url");
}

type SqlLibrary = Omit<
  LibraryRow,
  | "template"
  | "schema"
  | "tableProposal"
  | "tableProposalUnreadable"
  | "fieldProposal"
  | "fieldProposalUnreadable"
  | "writeMode"
  | "connectToken"
  | "readerKeyPrefix"
  | "readerKeyCreatedAt"
> & {
  template?: string;
  write_mode?: string;
  connect_token?: string;
  reader_key_prefix?: string | null;
  reader_key_created_at?: number | string | null;
  shelf_id?: string | null;
  schema?: unknown;
  table_proposal?: unknown;
  field_proposal?: unknown;
};

function asMillis(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toLibrary(row: SqlLibrary): LibraryRow {
  const template = libraryTemplate(row.template);
  const stored = parseStoredTableProposal(row.table_proposal);
  const fieldStored = parseStoredFieldProposal(row.field_proposal);
  return {
    id: row.id,
    name: row.name,
    template,
    writeMode: libraryWriteMode(row.write_mode),
    schema: librarySchemaOf(template, row.schema),
    tableProposal: stored.proposal,
    tableProposalUnreadable: stored.unreadable,
    fieldProposal: fieldStored.proposal,
    fieldProposalUnreadable: fieldStored.unreadable,
    connectToken: row.connect_token ?? "",
    readerKeyPrefix: row.reader_key_prefix || null,
    readerKeyCreatedAt: asMillis(row.reader_key_created_at),
    shelfId: row.shelf_id || null,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Lock one library row for the rest of this transaction.
 * Table approval and new items both take this lock so a proposal cannot
 * be applied in the same moment an item is inserted under the old columns.
 */
export async function lockLibrary(db: Database, id: string): Promise<LibraryRow | undefined> {
  const locked = await getRow<{ id: string }>(db, "SELECT id FROM libraries WHERE id = ? FOR UPDATE", id);
  if (!locked) return undefined;
  return getLibrary(db, id);
}

export async function listLibraries(db: Database): Promise<LibraryRow[]> {
  const rows = await allRows<SqlLibrary>(
    db,
    "SELECT * FROM libraries ORDER BY LOWER(name) ASC, name ASC",
  );
  return rows.map(toLibrary);
}

export async function getLibrary(db: Database, id: string): Promise<LibraryRow | undefined> {
  const row = await getRow<SqlLibrary>(db, "SELECT * FROM libraries WHERE id = ?", id);
  if (!row) return undefined;
  return toLibrary(row);
}

export async function createLibrary(
  db: Database,
  name: string,
  actorSub: string,
  template: LibraryTemplate = "general",
  table?: TableProposalDraft,
  writeMode: LibraryWriteMode = "reviewed",
  /** Portal Custom: the field set the human just confirmed. Locks on insert. */
  schemaOverride?: LibrarySchema,
): Promise<LibraryRow> {
  if (table && template !== "general") {
    throw new Error("A custom table is stored on a general library until a publisher approves it");
  }
  if (table && schemaOverride) {
    throw new Error("Pass a table proposal or a finished schema, not both");
  }
  if (schemaOverride && schemaOverride.starter !== template) {
    throw new Error("Schema starter must match the library template");
  }
  if (schemaOverride?.custom && template !== "general") {
    throw new Error("A custom schema is stored as a general library");
  }
  if (!isLibraryWriteMode(writeMode)) {
    throw new Error("write_mode must be reviewed or direct");
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const connectToken = freshConnectToken();
  const schema = schemaOverride ?? schemaForStarter(template);
  const proposal: TableProposal | null = table
    ? { ...table, proposedBy: actorSub, proposedAt: now }
    : null;
  // Insert + first publisher grant together so a library is never left ownerless.
  await db.transaction(async (tx) => {
    await runSql(
      tx,
      `INSERT INTO libraries (id, name, template, write_mode, schema, table_proposal, connect_token, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?)`,
      id,
      name.trim(),
      template,
      writeMode,
      JSON.stringify(schema),
      proposal ? JSON.stringify(proposal) : null,
      connectToken,
      actorSub,
      actorSub,
      now,
      now,
    );
    await grantLibraryAccess(tx, {
      libraryId: id,
      subject: actorSub,
      role: "publisher",
      grantedBy: actorSub,
    });
  });
  const created = await getLibrary(db, id);
  if (!created) throw new Error("failed to read library after insert");
  return created;
}

/**
 * Issue a new Connect link secret. Old MCP URLs stop working; access grants stay.
 * UI only — agents cannot rotate the link over MCP.
 */
export async function rotateLibraryConnectToken(
  db: Database,
  id: string,
  actorSub: string,
): Promise<LibraryRow | undefined> {
  const existing = await getLibrary(db, id);
  if (!existing) return undefined;
  const now = Date.now();
  await runSql(
    db,
    "UPDATE libraries SET connect_token = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    freshConnectToken(),
    actorSub,
    now,
    id,
  );
  return getLibrary(db, id);
}

/** Stored hash only. Callers compare it with readerKeyMatches and never send it to the browser. */
export async function getLibraryReaderKeyHash(db: Database, id: string): Promise<string | null> {
  const row = await getRow<{ reader_key_hash: string | null }>(
    db,
    "SELECT reader_key_hash FROM libraries WHERE id = ?",
    id,
  );
  return row?.reader_key_hash ?? null;
}

/**
 * Replace this library's Reader key. The plaintext is returned once.
 * The previous key stops working immediately. UI only — no MCP tool issues a key.
 */
export async function issueLibraryReaderKey(
  db: Database,
  id: string,
  actorSub: string,
): Promise<{ library: LibraryRow; key: string } | undefined> {
  const existing = await getLibrary(db, id);
  if (!existing) return undefined;
  const key = generateReaderKey();
  const now = Date.now();
  await runSql(
    db,
    `UPDATE libraries
     SET reader_key_hash = ?, reader_key_prefix = ?, reader_key_created_at = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    hashReaderKey(key),
    readerKeyPrefix(key),
    now,
    actorSub,
    now,
    id,
  );
  const library = await getLibrary(db, id);
  if (!library) return undefined;
  return { library, key };
}

/** Drop the Reader key. Connect and Access are unchanged. */
export async function clearLibraryReaderKey(
  db: Database,
  id: string,
  actorSub: string,
): Promise<LibraryRow | undefined> {
  const existing = await getLibrary(db, id);
  if (!existing) return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE libraries
     SET reader_key_hash = NULL, reader_key_prefix = NULL, reader_key_created_at = NULL,
         updated_by = ?, updated_at = ?
     WHERE id = ?`,
    actorSub,
    now,
    id,
  );
  return getLibrary(db, id);
}

/**
 * Rename a library. UI only — does not change schema, items, Access, or Connect.
 */
export async function renameLibrary(
  db: Database,
  id: string,
  name: string,
  actorSub: string,
): Promise<{ ok: true; library: LibraryRow } | { ok: false; message: string }> {
  const parsed = libraryInputSchema.safeParse({ name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Name is required" };
  }
  const existing = await getLibrary(db, id);
  if (!existing) return { ok: false, message: "Library not found." };
  if (existing.name === parsed.data.name) return { ok: true, library: existing };
  const now = Date.now();
  await runSql(
    db,
    "UPDATE libraries SET name = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    parsed.data.name,
    actorSub,
    now,
    id,
  );
  const library = await getLibrary(db, id);
  if (!library) return { ok: false, message: "Library not found." };
  return { ok: true, library };
}

/**
 * Copy one library's template into a new empty library.
 * Copies live schema, starter, and write mode. Does not copy items, Access,
 * Connect token, or waiting table/field proposals. Actor becomes publisher.
 */
export async function copyLibraryTemplate(
  db: Database,
  sourceId: string,
  name: string,
  actorSub: string,
): Promise<{ ok: true; library: LibraryRow } | { ok: false; message: string }> {
  const parsed = libraryInputSchema.safeParse({ name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Name is required" };
  }
  return db.transaction(async (tx) => {
    const source = await getLibrary(tx, sourceId);
    if (!source) return { ok: false, message: "Library not found." };
    const now = Date.now();
    const id = crypto.randomUUID();
    const connectToken = freshConnectToken();
    await runSql(
      tx,
      `INSERT INTO libraries (
         id, name, template, write_mode, schema, table_proposal, field_proposal,
         connect_token, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?::jsonb, NULL, NULL, ?, ?, ?, ?, ?)`,
      id,
      parsed.data.name,
      source.template,
      source.writeMode,
      JSON.stringify(source.schema),
      connectToken,
      actorSub,
      actorSub,
      now,
      now,
    );
    await grantLibraryAccess(tx, {
      libraryId: id,
      subject: actorSub,
      role: "publisher",
      grantedBy: actorSub,
    });
    const created = await getLibrary(tx, id);
    if (!created) return { ok: false, message: "Failed to read library after copy." };
    return { ok: true, library: created };
  });
}

/** Suggested name for a template copy (trimmed to the name max). */
export function suggestedCopyName(sourceName: string): string {
  const base = `${sourceName.trim()} copy`.replace(/\s+/g, " ").trim();
  return base.slice(0, 200) || "Library copy";
}

/**
 * Change how writes become visible. UI only — MCP has no tool for this.
 * Does not rewrite existing items; the next save follows the new mode.
 */
export async function setLibraryWriteMode(
  db: Database,
  id: string,
  writeMode: LibraryWriteMode,
  actorSub: string,
): Promise<LibraryRow | undefined> {
  if (!isLibraryWriteMode(writeMode)) {
    throw new Error("write_mode must be reviewed or direct");
  }
  const existing = await getLibrary(db, id);
  if (!existing) return undefined;
  if (existing.writeMode === writeMode) return existing;
  const now = Date.now();
  await runSql(
    db,
    "UPDATE libraries SET write_mode = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    writeMode,
    actorSub,
    now,
    id,
  );
  return getLibrary(db, id);
}

/**
 * Remove one library and the items in it.
 * publish_audit rows go first because they point at both the library and the items.
 * The frozen `records` table is left in place.
 * The last library stays, so the app always has one.
 */
export async function deleteLibrary(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existing = await getRow<{ id: string }>(tx, "SELECT id FROM libraries WHERE id = ?", id);
    if (!existing) return false;
    const count = await getRow<{ n: number }>(tx, "SELECT COUNT(*) AS n FROM libraries");
    if (Number(count?.n ?? 0) <= 1) {
      throw new Error("Keep at least one library");
    }
    await runSql(tx, "DELETE FROM publish_audit WHERE library_id = ?", id);
    await runSql(tx, "DELETE FROM items WHERE library_id = ?", id);
    await runSql(tx, "DELETE FROM libraries WHERE id = ?", id);
    return true;
  });
}

export async function defaultLibraryId(db: Database): Promise<string> {
  const row = await getRow<{ id: string }>(db, "SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1");
  if (!row) throw new Error("no libraries exist");
  return row.id;
}

/** Exact library name wins. A partial name is used only when it matches one library. */
export async function resolveLibrary(
  db: Database,
  input: { library_id?: string; library_name?: string },
): Promise<{ id: string } | { choices: { id: string; name: string }[] } | undefined> {
  if (input.library_id) {
    const row = await getLibrary(db, input.library_id);
    return row ? { id: row.id } : undefined;
  }
  const name = input.library_name?.trim();
  if (!name) return undefined;
  const exact = await allRows<{ id: string; name: string }>(
    db,
    "SELECT id, name FROM libraries WHERE LOWER(name) = LOWER(?)",
    name,
  );
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { choices: exact };
  const partial = await allRows<{ id: string; name: string }>(
    db,
    "SELECT id, name FROM libraries WHERE name ILIKE ? ESCAPE '\\' ORDER BY LOWER(name) ASC, name ASC",
    `%${escapeLike(name)}%`,
  );
  if (partial.length === 1) return { id: partial[0].id };
  if (partial.length > 1) return { choices: partial };
  return undefined;
}
