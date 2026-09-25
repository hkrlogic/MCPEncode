import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { connect, type Database } from "@tursodatabase/database";
import { applyMigrations } from "./migrate.ts";

let dbPromise: Promise<Database> | undefined;

export async function openDatabase(databasePath: string): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const resolved = path.resolve(databasePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      const db = await connect(resolved, { timeout: 5000 });
      // Required so items.library_id cannot point at a missing library.
      await db.exec("PRAGMA foreign_keys = ON");
      await applyMigrations(db);
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

/** Test helper: drop the cached connection. */
export function resetDatabaseCache(): void {
  dbPromise = undefined;
}
