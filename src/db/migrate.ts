import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaForStarter } from "../items/library-schema.ts";
import { isLibraryTemplate, type LibraryTemplate } from "../items/templates.ts";
import type { Database } from "./types.ts";

/** Known id/name inserted only when a database has no library yet. */
export const DEFAULT_LIBRARY_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_LIBRARY_NAME = "Main";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

function asTemplate(value: string | undefined): LibraryTemplate {
  return value && isLibraryTemplate(value) ? value : "general";
}

/**
 * Fill libraries.schema from the starter catalog when the column is null.
 * Safe to run on every startup; only touches rows that still need a copy.
 */
export async function backfillLibrarySchemas(db: Database): Promise<void> {
  const rows = (await db.all(
    "SELECT id, template FROM libraries WHERE schema IS NULL",
  )) as { id: string; template: string }[];
  for (const row of rows) {
    const schema = schemaForStarter(asTemplate(row.template));
    await db.run("UPDATE libraries SET schema = ?::jsonb WHERE id = ? AND schema IS NULL", JSON.stringify(schema), row.id);
  }
}

/**
 * Apply SQL files in migrations/ once, in filename order.
 * Skips subdirectories (e.g. mariadb_archive/). Files are idempotent.
 */
export async function applyMigrations(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) NOT NULL,
      applied_at BIGINT NOT NULL,
      PRIMARY KEY (version)
    )
  `);
  const appliedRows = (await db.all("SELECT version FROM schema_migrations")) as { version: string }[];
  const applied = new Set(appliedRows.map((row) => row.version));
  const files = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.exec(sql);
    await db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      file,
      Date.now(),
    );
  }
  await backfillLibrarySchemas(db);
}
