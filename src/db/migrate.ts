import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@tursodatabase/database";

/** Known id/name inserted only when a database has no library yet. */
export const DEFAULT_LIBRARY_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_LIBRARY_NAME = "Main";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * Apply SQL files in migrations/ once, in filename order.
 * Files are idempotent. records is never dropped.
 */
export async function applyMigrations(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedRows = (await db.all("SELECT version FROM schema_migrations")) as { version: string }[];
  const applied = new Set(appliedRows.map((row) => row.version));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    if (file.startsWith("002")) {
      await ensureRecordsLibraryId(db);
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.exec(sql);
    await db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      file,
      Date.now(),
    );
  }
}

/**
 * Older POC files created records before library_id existed.
 * ADD COLUMN has no safe IF NOT EXISTS here, so this runs only when needed.
 * The statement is also written in migrations/002_items.sql.
 */
async function ensureRecordsLibraryId(db: Database): Promise<void> {
  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'",
  )) as { name: string }[];
  if (tables.length === 0) return;
  const columns = (await db.all("PRAGMA table_info(records)")) as { name: string }[];
  if (columns.some((column) => column.name === "library_id")) return;
  await db.exec("ALTER TABLE records ADD COLUMN library_id TEXT NOT NULL DEFAULT ''");
}
