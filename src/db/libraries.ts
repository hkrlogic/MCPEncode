/** Library CRUD and name/id resolution for lookups. */
import type { Database } from "./types.ts";
import type { LibraryTemplate } from "../items/templates.ts";
import { grantLibraryAccess } from "./access.ts";
import type { LibraryRow } from "./models.ts";
import { allRows, escapeLike, getRow, runSql } from "./query-helpers.ts";

function libraryTemplate(value: string | undefined): LibraryTemplate {
  if (value === "policy" || value === "procedure") return value;
  return "general";
}

export async function listLibraries(db: Database): Promise<LibraryRow[]> {
  // utf8mb4_unicode_ci is case-insensitive, so name order matches the old NOCASE sort.
  const rows = await allRows<LibraryRow & { template?: string }>(
    db,
    "SELECT * FROM libraries ORDER BY name ASC",
  );
  return rows.map((row) => ({
    ...row,
    template: libraryTemplate(row.template),
  }));
}

export async function getLibrary(db: Database, id: string): Promise<LibraryRow | undefined> {
  const row = await getRow<LibraryRow & { template?: string }>(db, "SELECT * FROM libraries WHERE id = ?", id);
  if (!row) return undefined;
  return { ...row, template: libraryTemplate(row.template) };
}

export async function createLibrary(
  db: Database,
  name: string,
  actorSub: string,
  template: LibraryTemplate = "general",
): Promise<LibraryRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  await runSql(
    db,
    `INSERT INTO libraries (id, name, template, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    name.trim(),
    template,
    actorSub,
    actorSub,
    now,
    now,
  );
  await grantLibraryAccess(db, {
    libraryId: id,
    subject: actorSub,
    role: "publisher",
    grantedBy: actorSub,
  });
  const created = await getLibrary(db, id);
  if (!created) throw new Error("failed to read library after insert");
  return created;
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
    // item_field_values cascade from items; library_schemas cascade from libraries
    await runSql(tx, "DELETE FROM items WHERE library_id = ?", id);
    await runSql(tx, "DELETE FROM library_schemas WHERE library_id = ?", id);
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
    "SELECT id, name FROM libraries WHERE name = ?",
    name,
  );
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { choices: exact };
  const partial = await allRows<{ id: string; name: string }>(
    db,
    // JavaScript and MariaDB each treat backslash as an escape, so four
    // slashes here become the single ESCAPE '\' character.
    "SELECT id, name FROM libraries WHERE name LIKE ? ESCAPE '\\\\' ORDER BY name ASC",
    `%${escapeLike(name)}%`,
  );
  if (partial.length === 1) return { id: partial[0].id };
  if (partial.length > 1) return { choices: partial };
  return undefined;
}
