import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connect } from "@tursodatabase/database";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME, applyMigrations } from "../src/db/migrate.ts";

const OLD_POC = `
CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

async function count(db: { all: (sql: string) => Promise<unknown[]> }, table: string): Promise<number> {
  const rows = (await db.all(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

test("fresh database gets Main and keeps records", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "fresh.db"));
  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('records', 'items', 'publish_audit', 'libraries')",
  )) as { name: string }[];
  assert.deepEqual(tables.map((row) => row.name).sort(), ["items", "libraries", "publish_audit", "records"]);
  const library = (await db.get("SELECT id, name FROM libraries")) as { id: string; name: string };
  assert.equal(library.id, DEFAULT_LIBRARY_ID);
  assert.equal(library.name, DEFAULT_LIBRARY_NAME);
  assert.equal(await count(db, "records"), 0);
  assert.equal(await count(db, "items"), 0);
  const dropped = (await db.all(
    "SELECT sql FROM sqlite_master WHERE sql LIKE '%DROP TABLE%'",
  )) as { sql: string }[];
  assert.equal(dropped.length, 0);
  resetDatabaseCache();
});

test("existing POC notes rows copy into items and records stays", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const file = path.join(dir, "poc.db");
  const legacy = await connect(file, { timeout: 5000 });
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
  const db = await openDatabase(file);
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
  resetDatabaseCache();
});
