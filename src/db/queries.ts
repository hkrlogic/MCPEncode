import type { Database } from "@tursodatabase/database";
import { excerptOf, type ItemInput, type ListQuery } from "../items/schema.ts";

export type LibraryRow = {
  id: string;
  name: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type RecordRow = {
  id: string;
  library_id: string;
  title: string;
  notes: string;
  tags: string[];
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type RecordSummary = {
  id: string;
  library_id: string;
  title: string;
  tags: string[];
  updated_at: number;
  excerpt: string;
};

export type AuditRow = {
  id: string;
  actor_sub: string;
  tool: string;
  success: boolean;
  detail: string;
  created_at: number;
};

type SqlRecord = {
  id: string;
  library_id: string;
  title: string;
  notes: string;
  tags: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function toRecord(row: SqlRecord): RecordRow {
  return { ...row, tags: parseTags(row.tags) };
}

function toSummary(row: SqlRecord): RecordSummary {
  return {
    id: row.id,
    library_id: row.library_id,
    title: row.title,
    tags: parseTags(row.tags),
    updated_at: row.updated_at,
    excerpt: excerptOf(row.notes),
  };
}

async function allRows<T>(db: Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = await db.prepare(sql);
  return (await stmt.all(...params)) as T[];
}

async function getRow<T>(db: Database, sql: string, ...params: unknown[]): Promise<T | undefined> {
  const stmt = await db.prepare(sql);
  return (await stmt.get(...params)) as T | undefined;
}

async function runSql(db: Database, sql: string, ...params: unknown[]): Promise<void> {
  const stmt = await db.prepare(sql);
  await stmt.run(...params);
}

export async function listLibraries(db: Database): Promise<LibraryRow[]> {
  return allRows<LibraryRow>(db, "SELECT * FROM libraries ORDER BY name COLLATE NOCASE ASC");
}

export async function getLibrary(db: Database, id: string): Promise<LibraryRow | undefined> {
  return getRow<LibraryRow>(db, "SELECT * FROM libraries WHERE id = ?", id);
}

export async function createLibrary(db: Database, name: string, actorSub: string): Promise<LibraryRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  await runSql(
    db,
    `INSERT INTO libraries (id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    name.trim(),
    actorSub,
    actorSub,
    now,
    now,
  );
  const created = await getLibrary(db, id);
  if (!created) throw new Error("failed to read library after insert");
  return created;
}

export async function defaultLibraryId(db: Database): Promise<string> {
  const row = await getRow<{ id: string }>(db, "SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1");
  if (!row) throw new Error("no libraries exist");
  return row.id;
}

export async function listRecords(db: Database, query: ListQuery = {}): Promise<RecordSummary[]> {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const rows = query.library_id
    ? await allRows<SqlRecord>(
        db,
        "SELECT * FROM records WHERE library_id = ? ORDER BY updated_at DESC",
        query.library_id,
      )
    : await allRows<SqlRecord>(db, "SELECT * FROM records ORDER BY updated_at DESC");
  const needle = query.q?.toLowerCase();
  const tag = query.tag?.toLowerCase();
  return rows
    .map(toSummary)
    .filter((row) => {
      if (tag && !row.tags.includes(tag)) return false;
      if (!needle) return true;
      return (
        row.title.toLowerCase().includes(needle) ||
        row.tags.some((entry) => entry.includes(needle)) ||
        row.excerpt.toLowerCase().includes(needle)
      );
    })
    .slice(offset, offset + limit);
}

export async function getRecord(db: Database, id: string): Promise<RecordRow | undefined> {
  const row = await getRow<SqlRecord>(db, "SELECT * FROM records WHERE id = ?", id);
  return row ? toRecord(row) : undefined;
}

export async function createRecord(
  db: Database,
  input: ItemInput,
  actorSub: string,
  libraryId?: string,
): Promise<RecordRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const library_id = libraryId || (await defaultLibraryId(db));
  await runSql(
    db,
    `INSERT INTO records (id, library_id, title, notes, tags, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    library_id,
    input.title,
    input.notes,
    JSON.stringify(input.tags),
    actorSub,
    actorSub,
    now,
    now,
  );
  const created = await getRecord(db, id);
  if (!created) throw new Error("failed to read record after insert");
  return created;
}

export async function updateRecord(
  db: Database,
  id: string,
  input: ItemInput,
  actorSub: string,
): Promise<RecordRow | undefined> {
  const existing = await getRecord(db, id);
  if (!existing) return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE records SET title = ?, notes = ?, tags = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    input.title,
    input.notes,
    JSON.stringify(input.tags),
    actorSub,
    now,
    id,
  );
  return getRecord(db, id);
}

export async function deleteRecord(db: Database, id: string): Promise<boolean> {
  const existing = await getRecord(db, id);
  if (!existing) return false;
  await runSql(db, "DELETE FROM records WHERE id = ?", id);
  return true;
}

export async function writeAudit(
  db: Database,
  event: { actorSub: string; tool: string; success: boolean; detail?: string },
): Promise<void> {
  await runSql(
    db,
    `INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    event.actorSub,
    event.tool,
    event.success ? 1 : 0,
    event.detail ?? "",
    Date.now(),
  );
}

export async function listAudit(db: Database, limit = 50): Promise<AuditRow[]> {
  const rows = await allRows<{
    id: string;
    actor_sub: string;
    tool: string;
    success: number;
    detail: string;
    created_at: number;
  }>(db, "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", limit);
  return rows.map((row) => ({
    id: row.id,
    actor_sub: row.actor_sub,
    tool: row.tool,
    success: row.success === 1,
    detail: row.detail,
    created_at: row.created_at,
  }));
}
