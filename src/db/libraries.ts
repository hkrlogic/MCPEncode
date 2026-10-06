/** Library CRUD and name/id resolution for lookups. */
import type { Database } from "./types.ts";
import { librarySchemaOf, schemaForStarter } from "../items/library-schema.ts";
import { isLibraryWriteMode, type LibraryWriteMode } from "../items/schema.ts";
import { parseStoredTableProposal, type TableProposal, type TableProposalDraft } from "../items/table-proposal.ts";
import { isLibraryTemplate, type LibraryTemplate } from "../items/templates.ts";
import { grantLibraryAccess } from "./access.ts";
import type { LibraryRow } from "./models.ts";
import { allRows, escapeLike, getRow, runSql } from "./query-helpers.ts";

function libraryTemplate(value: string | undefined): LibraryTemplate {
  return value && isLibraryTemplate(value) ? value : "general";
}

function libraryWriteMode(value: string | undefined): LibraryWriteMode {
  return value && isLibraryWriteMode(value) ? value : "reviewed";
}

type SqlLibrary = Omit<
  LibraryRow,
  "template" | "schema" | "tableProposal" | "tableProposalUnreadable" | "writeMode"
> & {
  template?: string;
  write_mode?: string;
  schema?: unknown;
  table_proposal?: unknown;
};

function toLibrary(row: SqlLibrary): LibraryRow {
  const template = libraryTemplate(row.template);
  const stored = parseStoredTableProposal(row.table_proposal);
  return {
    id: row.id,
    name: row.name,
    template,
    writeMode: libraryWriteMode(row.write_mode),
    schema: librarySchemaOf(template, row.schema),
    tableProposal: stored.proposal,
    tableProposalUnreadable: stored.unreadable,
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
): Promise<LibraryRow> {
  if (table && template !== "general") {
    throw new Error("A custom table is stored on a general library until a publisher approves it");
  }
  if (!isLibraryWriteMode(writeMode)) {
    throw new Error("write_mode must be reviewed or direct");
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const schema = schemaForStarter(template);
  const proposal: TableProposal | null = table
    ? { ...table, proposedBy: actorSub, proposedAt: now }
    : null;
  // Insert + first publisher grant together so a library is never left ownerless.
  await db.transaction(async (tx) => {
    await runSql(
      tx,
      `INSERT INTO libraries (id, name, template, write_mode, schema, table_proposal, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)`,
      id,
      name.trim(),
      template,
      writeMode,
      JSON.stringify(schema),
      proposal ? JSON.stringify(proposal) : null,
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
