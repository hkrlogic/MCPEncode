import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { connect, type Database } from "@tursodatabase/database";

let dbPromise: Promise<Database> | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_sub TEXT NOT NULL,
  tool TEXT NOT NULL,
  success INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS records_updated_at ON records (updated_at DESC);
CREATE INDEX IF NOT EXISTS libraries_updated_at ON libraries (updated_at DESC);
CREATE INDEX IF NOT EXISTS audit_created_at ON audit_events (created_at DESC);
`;

export async function openDatabase(databasePath: string): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const resolved = path.resolve(databasePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      const db = await connect(resolved, { timeout: 5000 });
      await db.exec(SCHEMA);
      await migrateDatabase(db);
      try {
        await chmod(resolved, 0o600);
      } catch {
        // chmod can fail on some filesystems; the file is still local-only.
      }
      return db;
    })();
  }
  return dbPromise;
}

/** Add library_id to older files and put existing items in a Main library. */
async function migrateDatabase(db: Database): Promise<void> {
  const info = await db.prepare("PRAGMA table_info(records)");
  const columns = (await info.all()) as { name: string }[];
  if (!columns.some((column) => column.name === "library_id")) {
    await db.exec("ALTER TABLE records ADD COLUMN library_id TEXT NOT NULL DEFAULT ''");
  }
  const first = await db.prepare("SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1");
  let library = (await first.get()) as { id: string } | undefined;
  if (!library) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const insert = await db.prepare(
      `INSERT INTO libraries (id, name, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    await insert.run(id, "Main", "system", "system", now, now);
    library = { id };
  }
  const backfill = await db.prepare("UPDATE records SET library_id = ? WHERE library_id = ''");
  await backfill.run(library.id);
  await db.exec("CREATE INDEX IF NOT EXISTS records_library_id ON records (library_id)");
}

/** Test helper: drop the cached connection. */
export function resetDatabaseCache(): void {
  dbPromise = undefined;
}
