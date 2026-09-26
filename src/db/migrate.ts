import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./types.ts";

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
      version VARCHAR(255) NOT NULL,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
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
 * Older databases created records before library_id existed.
 * ADD COLUMN has no safe IF NOT EXISTS here, so this runs only when needed.
 * The statement is also written in migrations/002_items.sql.
 */
async function ensureRecordsLibraryId(db: Database): Promise<void> {
  const tables = (await db.all(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'records'`,
  )) as { name: string }[];
  if (tables.length === 0) return;
  const columns = (await db.all(
    `SELECT column_name AS name
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'records'
       AND column_name = 'library_id'`,
  )) as { name: string }[];
  if (columns.length > 0) return;
  await db.exec("ALTER TABLE records ADD COLUMN library_id VARCHAR(36) NOT NULL DEFAULT ''");
}
