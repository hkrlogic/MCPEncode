/**
 * Shelves bond libraries for one published-item search.
 * A shelf does not grant Access, and it does not edit items.
 */
import type { Database } from "./types.ts";
import { libraryInputSchema } from "../items/schema.ts";
import { allRows, escapeLike, getRow, runSql } from "./query-helpers.ts";

export type ShelfRow = {
  id: string;
  name: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

/** One published item on a shelf search. The body stays in the library. */
export type ShelfHit = {
  libraryId: string;
  libraryName: string;
  itemId: string;
  name: string;
  summary: string;
};

const SHELF_HITS_MAX = 40;

export async function listShelves(db: Database): Promise<ShelfRow[]> {
  return allRows<ShelfRow>(
    db,
    "SELECT id, name, created_by, updated_by, created_at, updated_at FROM shelves ORDER BY LOWER(name) ASC, name ASC",
  );
}

export async function getShelf(db: Database, id: string): Promise<ShelfRow | undefined> {
  return getRow<ShelfRow>(
    db,
    "SELECT id, name, created_by, updated_by, created_at, updated_at FROM shelves WHERE id = ?",
    id,
  );
}

export async function createShelf(
  db: Database,
  name: string,
  actorSub: string,
): Promise<{ ok: true; shelf: ShelfRow } | { ok: false; message: string }> {
  const parsed = libraryInputSchema.safeParse({ name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Name is required" };
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await runSql(
    db,
    `INSERT INTO shelves (id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    parsed.data.name,
    actorSub,
    actorSub,
    now,
    now,
  );
  const shelf = await getShelf(db, id);
  if (!shelf) return { ok: false, message: "Failed to read shelf after insert." };
  return { ok: true, shelf };
}

export async function renameShelf(
  db: Database,
  id: string,
  name: string,
  actorSub: string,
): Promise<{ ok: true; shelf: ShelfRow } | { ok: false; message: string }> {
  const parsed = libraryInputSchema.safeParse({ name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Name is required" };
  }
  const existing = await getShelf(db, id);
  if (!existing) return { ok: false, message: "Shelf not found." };
  if (existing.name === parsed.data.name) return { ok: true, shelf: existing };
  await runSql(
    db,
    "UPDATE shelves SET name = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    parsed.data.name,
    actorSub,
    Date.now(),
    id,
  );
  const shelf = await getShelf(db, id);
  if (!shelf) return { ok: false, message: "Shelf not found." };
  return { ok: true, shelf };
}

/** Drop the bond. Libraries remain; their shelf_id becomes null. */
export async function deleteShelf(db: Database, id: string): Promise<boolean> {
  const existing = await getShelf(db, id);
  if (!existing) return false;
  await runSql(db, "DELETE FROM shelves WHERE id = ?", id);
  return true;
}

/**
 * Put a library on one shelf, or clear it. Passing a missing shelf id fails.
 * Does not copy items or change Access.
 */
export async function setLibraryShelf(
  db: Database,
  libraryId: string,
  shelfId: string | null,
  actorSub: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const library = await getRow<{ id: string }>(db, "SELECT id FROM libraries WHERE id = ?", libraryId);
  if (!library) return { ok: false, message: "Library not found." };
  if (shelfId) {
    const shelf = await getShelf(db, shelfId);
    if (!shelf) return { ok: false, message: "Shelf not found." };
  }
  await runSql(
    db,
    "UPDATE libraries SET shelf_id = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    shelfId,
    actorSub,
    Date.now(),
    libraryId,
  );
  return { ok: true };
}

/** Libraries on this shelf, name order. Used to draw the bond before a search. */
export async function listShelfLibraries(
  db: Database,
  shelfId: string,
): Promise<{ id: string; name: string }[]> {
  return allRows(
    db,
    "SELECT id, name FROM libraries WHERE shelf_id = ? ORDER BY LOWER(name) ASC, name ASC",
    shelfId,
  );
}

/**
 * Published items on this shelf, limited to libraries the caller can read.
 * `sa` sees every library on the shelf. `includeLibraryId` covers a Reader key,
 * which has no access-list row but may read that one library.
 * Returns names and summaries only.
 */
/** Filler words ignored when a shelf phrase is split into words. */
const SHELF_STOP_WORDS = new Set(["the", "and", "for", "how", "what", "with", "from", "about", "when", "does", "can", "you", "your"]);

export async function searchShelf(
  db: Database,
  shelfId: string,
  q: string,
  scope: { subject: string; sa: boolean; includeLibraryId?: string },
): Promise<ShelfHit[]> {
  const needle = q.trim();
  if (!needle) return [];
  const readable = await readableShelfLibraryIds(db, shelfId, scope);
  if (readable.length === 0) return [];
  const pattern = `%${escapeLike(needle)}%`;
  const placeholders = readable.map(() => "?").join(", ");
  let rows = await allRows<{
    item_id: string;
    name: string;
    summary: string;
    library_id: string;
    library_name: string;
  }>(
    db,
    `SELECT i.id AS item_id, i.name, i.summary, l.id AS library_id, l.name AS library_name
     FROM items_live i
     INNER JOIN libraries l ON l.id = i.library_id
     WHERE l.shelf_id = ?
       AND i.status = 'published'
       AND l.id IN (${placeholders})
       AND (i.name ILIKE ? ESCAPE '\\' OR i.summary ILIKE ? ESCAPE '\\' OR i.labels::text ILIKE ? ESCAPE '\\')
     ORDER BY LOWER(l.name) ASC, LOWER(i.name) ASC, i.name ASC
     LIMIT ${SHELF_HITS_MAX}`,
    shelfId,
    ...readable,
    pattern,
    pattern,
    pattern,
  );
  if (rows.length === 0) {
    // The whole phrase is not in any name, summary or label ("password reset").
    // Try again with every word required somewhere in name, summary or labels.
    const tokens = [...new Set(needle.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
      (token) => token.length >= 3 && !SHELF_STOP_WORDS.has(token),
    );
    if (tokens.length >= 2) {
      const clauses = tokens
        .map(() => "(i.name ILIKE ? ESCAPE '\\' OR i.summary ILIKE ? ESCAPE '\\' OR i.labels::text ILIKE ? ESCAPE '\\')")
        .join(" AND ");
      const params = tokens.flatMap((token) => {
        const like = `%${escapeLike(token)}%`;
        return [like, like, like];
      });
      rows = await allRows(
        db,
        `SELECT i.id AS item_id, i.name, i.summary, l.id AS library_id, l.name AS library_name
         FROM items_live i
         INNER JOIN libraries l ON l.id = i.library_id
         WHERE l.shelf_id = ?
           AND i.status = 'published'
           AND l.id IN (${placeholders})
           AND ${clauses}
         ORDER BY LOWER(l.name) ASC, LOWER(i.name) ASC, i.name ASC
         LIMIT ${SHELF_HITS_MAX}`,
        shelfId,
        ...readable,
        ...params,
      );
    }
  }
  return rows.map((row) => ({
    libraryId: row.library_id,
    libraryName: row.library_name,
    itemId: row.item_id,
    name: row.name,
    summary: row.summary,
  }));
}

async function readableShelfLibraryIds(
  db: Database,
  shelfId: string,
  scope: { subject: string; sa: boolean; includeLibraryId?: string },
): Promise<string[]> {
  if (scope.sa) {
    const rows = await allRows<{ id: string }>(
      db,
      "SELECT id FROM libraries WHERE shelf_id = ?",
      shelfId,
    );
    return rows.map((row) => row.id);
  }
  const rows = await allRows<{ id: string }>(
    db,
    `SELECT l.id
     FROM libraries l
     LEFT JOIN library_access a ON a.library_id = l.id AND a.subject = ?
     WHERE l.shelf_id = ?
       AND (a.subject IS NOT NULL OR l.id = ?)`,
    scope.subject,
    shelfId,
    scope.includeLibraryId ?? "",
  );
  return rows.map((row) => row.id);
}
