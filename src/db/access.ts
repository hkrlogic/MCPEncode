/** Who may open a library (IdP subject) and their role on that library. */
import type { Database } from "./types.ts";
import { allRows, getRow, runSql } from "./query-helpers.ts";

export type LibraryAccessRole = "reader" | "publisher";

export type LibraryAccessRow = {
  library_id: string;
  subject: string;
  role: LibraryAccessRole;
  granted_by: string;
  created_at: number;
};

function asRole(value: string): LibraryAccessRole {
  return value === "publisher" ? "publisher" : "reader";
}

export async function listLibraryAccess(
  db: Database,
  libraryId: string,
): Promise<LibraryAccessRow[]> {
  const rows = await allRows<LibraryAccessRow>(
    db,
    `SELECT library_id, subject, role, granted_by, created_at
     FROM library_access
     WHERE library_id = ?
     ORDER BY role DESC, subject ASC`,
    libraryId,
  );
  return rows.map((row) => ({ ...row, role: asRole(row.role) }));
}

export async function getLibraryAccess(
  db: Database,
  libraryId: string,
  subject: string,
): Promise<LibraryAccessRow | undefined> {
  const row = await getRow<LibraryAccessRow>(
    db,
    `SELECT library_id, subject, role, granted_by, created_at
     FROM library_access
     WHERE library_id = ? AND subject = ?`,
    libraryId,
    subject,
  );
  return row ? { ...row, role: asRole(row.role) } : undefined;
}

export async function countLibraryAccess(db: Database, libraryId: string): Promise<number> {
  const row = await getRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM library_access WHERE library_id = ?",
    libraryId,
  );
  return Number(row?.n ?? 0);
}

/** Libraries this subject may open (readers and publishers). */
export async function listLibrariesForSubject(
  db: Database,
  subject: string,
): Promise<{ id: string; name: string; template: string; access_role: LibraryAccessRole }[]> {
  const rows = await allRows<{
    id: string;
    name: string;
    template: string;
    access_role: string;
  }>(
    db,
    `SELECT l.id, l.name, l.template, a.role AS access_role
     FROM libraries l
     INNER JOIN library_access a ON a.library_id = l.id
     WHERE a.subject = ?
     ORDER BY l.name ASC`,
    subject,
  );
  return rows.map((row) => ({
    ...row,
    access_role: asRole(row.access_role),
  }));
}

/** Libraries with nobody on the access list (safe for an IdP editor to claim). */
export async function listOrphanLibraries(
  db: Database,
): Promise<{ id: string; name: string; template: string }[]> {
  return allRows(
    db,
    `SELECT l.id, l.name, l.template
     FROM libraries l
     LEFT JOIN library_access a ON a.library_id = l.id
     WHERE a.library_id IS NULL
     ORDER BY l.name ASC`,
  );
}

export async function grantLibraryAccess(
  db: Database,
  input: {
    libraryId: string;
    subject: string;
    role: LibraryAccessRole;
    grantedBy: string;
  },
): Promise<LibraryAccessRow> {
  const subject = input.subject.trim();
  if (!subject) throw new Error("Subject is required");
  if (subject.length > 255) throw new Error("Subject is too long");
  const now = Date.now();
  await runSql(
    db,
    `INSERT INTO library_access (library_id, subject, role, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
    input.libraryId,
    subject,
    input.role,
    input.grantedBy,
    now,
  );
  const row = await getLibraryAccess(db, input.libraryId, subject);
  if (!row) throw new Error("failed to read library access after grant");
  return row;
}

/**
 * Remove one subject from a library.
 * The last publisher stays, so the library is never locked with only readers.
 */
export async function revokeLibraryAccess(
  db: Database,
  libraryId: string,
  subject: string,
): Promise<boolean> {
  const existing = await getLibraryAccess(db, libraryId, subject);
  if (!existing) return false;
  if (existing.role === "publisher") {
    const publishers = await getRow<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM library_access
       WHERE library_id = ? AND role = 'publisher'`,
      libraryId,
    );
    if (Number(publishers?.n ?? 0) <= 1) {
      throw new Error("Keep at least one publisher on this library");
    }
  }
  await runSql(
    db,
    "DELETE FROM library_access WHERE library_id = ? AND subject = ?",
    libraryId,
    subject,
  );
  return true;
}
