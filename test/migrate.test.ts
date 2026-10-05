import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME } from "../src/db/migrate.ts";
import { getLibrary } from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";

async function count(db: { all: (sql: string) => Promise<unknown[]> }, table: string): Promise<number> {
  const rows = (await db.all(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

test("fresh database gets Main and keeps records", async () => {
  await withTestDatabase(async (db) => {
    const tables = (await db.all(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('records', 'items', 'publish_audit', 'libraries', 'library_access')`,
    )) as { name: string }[];
    assert.deepEqual(
      tables.map((row) => row.name).sort(),
      ["items", "libraries", "library_access", "publish_audit", "records"],
    );
    const library = (await db.get("SELECT id, name FROM libraries")) as { id: string; name: string };
    assert.equal(library.id, DEFAULT_LIBRARY_ID);
    assert.equal(library.name, DEFAULT_LIBRARY_NAME);
    assert.equal(await count(db, "records"), 0);
    assert.equal(await count(db, "items"), 0);
    const bodyCol = (await db.all(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'body'`,
    )) as { name: string }[];
    assert.equal(bodyCol.length, 1);
    const tsvCol = (await db.all(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'search_tsv'`,
    )) as { name: string }[];
    assert.equal(tsvCol.length, 1);
    const schemaCol = (await db.all(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'schema'`,
    )) as { name: string }[];
    assert.equal(schemaCol.length, 1);
    const main = await getLibrary(db, DEFAULT_LIBRARY_ID);
    assert.equal(main?.schema.starter, "general");
    assert.ok(main?.schema.fields.some((field) => field.key === "body"));
  });
});
