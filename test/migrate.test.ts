import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME, applyMigrations } from "../src/db/migrate.ts";
import type { Database } from "../src/db/types.ts";
import { disposableDatabase, withTestDatabase } from "./db.ts";

const OLD_POC = `
CREATE TABLE libraries (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE records (
  id VARCHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  notes MEDIUMTEXT NOT NULL,
  tags TEXT NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

async function count(db: { all: (sql: string) => Promise<unknown[]> }, table: string): Promise<number> {
  const rows = (await db.all(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

test("fresh database gets Main and keeps records", async () => {
  await withTestDatabase(async (db) => {
    const tables = (await db.all(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN ('records', 'items', 'publish_audit', 'libraries')`,
    )) as { name: string }[];
    assert.deepEqual(
      tables.map((row) => row.name).sort(),
      ["items", "libraries", "publish_audit", "records"],
    );
    const library = (await db.get("SELECT id, name FROM libraries")) as { id: string; name: string };
    assert.equal(library.id, DEFAULT_LIBRARY_ID);
    assert.equal(library.name, DEFAULT_LIBRARY_NAME);
    assert.equal(await count(db, "records"), 0);
    assert.equal(await count(db, "items"), 0);
    const bodyCol = (await db.all(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'items' AND column_name = 'body'`,
    )) as { name: string }[];
    assert.equal(bodyCol.length, 1);
  });
});

test("existing notes rows copy into items and records stays", async () => {
  const { config, cleanup } = await disposableDatabase();
  try {
    resetDatabaseCache();
    const legacy = await openDatabase(config, { migrate: false });
    await legacy.exec(OLD_POC);
    const now = Date.now();
    await legacy.run(
      `INSERT INTO records (id, title, notes, tags, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "11111111-1111-4111-8111-111111111111",
      "Weekly rings",
      "Prod Thursday\n\nShip the ring.",
      '["ops"]',
      "alice",
      "alice",
      now,
      now,
    );
    await legacy.run(
      `INSERT INTO records (id, title, notes, tags, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "22222222-2222-4222-8222-222222222222",
      "Empty body",
      "",
      "[]",
      "alice",
      "alice",
      now,
      now,
    );
    const notesBefore = await count(legacy, "records");
    assert.equal(notesBefore, 2);
    await legacy.close();

    resetDatabaseCache();
    const db: Database = await openDatabase(config);
    try {
      const notesAfter = await count(db, "records");
      const itemsAfter = await count(db, "items");
      assert.equal(notesAfter, notesBefore);
      assert.equal(itemsAfter, notesBefore);
      const library = (await db.get(
        "SELECT id, name FROM libraries ORDER BY created_at ASC LIMIT 1",
      )) as { id: string; name: string };
      assert.equal(library.id, DEFAULT_LIBRARY_ID);
      assert.equal(library.name, DEFAULT_LIBRARY_NAME);
      const copied = (await db.get(
        "SELECT library_id, summary, status FROM items WHERE name = ?",
        "Weekly rings",
      )) as { library_id: string; summary: string; status: string };
      assert.equal(copied.library_id, DEFAULT_LIBRARY_ID);
      assert.equal(copied.summary, "Prod Thursday");
      assert.equal(copied.status, "published");
      const named = (await db.get("SELECT summary FROM items WHERE name = ?", "Empty body")) as {
        summary: string;
      };
      assert.equal(named.summary, "Empty body");
      await applyMigrations(db);
      assert.equal(await count(db, "items"), notesBefore);
      assert.equal(await count(db, "records"), notesBefore);
    } finally {
      await db.close();
    }
  } finally {
    resetDatabaseCache();
    await cleanup();
  }
});
