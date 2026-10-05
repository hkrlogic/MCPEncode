import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackHost, resolvePostgresSsl } from "../src/config.ts";
import { toPgParams } from "../src/db/client.ts";
import { assertNoDropTable, splitSql } from "../src/db/sql.ts";

test("migration splitter ignores semicolons in comments and strings", () => {
  const parts = splitSql(`
    -- DROP TABLE records;
    SELECT 'a;b';
    /* ; */
    SELECT 1;
  `);
  assert.deepEqual(parts, ["SELECT 'a;b'", "SELECT 1"]);
});

test("drop table is rejected", () => {
  assert.throws(() => assertNoDropTable("DROP TABLE records"), /records is kept/);
  assert.throws(() => assertNoDropTable("drop table if exists items"), /records is kept/);
});

test("toPgParams rewrites ? placeholders to $n", () => {
  assert.equal(toPgParams("SELECT 1"), "SELECT 1");
  assert.equal(toPgParams("SELECT * FROM items WHERE id = ?"), "SELECT * FROM items WHERE id = $1");
  assert.equal(
    toPgParams("INSERT INTO t (a, b) VALUES (?, ?::jsonb)"),
    "INSERT INTO t (a, b) VALUES ($1, $2::jsonb)",
  );
});

test("remote Postgres requires an explicit SSL choice", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(resolvePostgresSsl("127.0.0.1", undefined), false);
  assert.equal(resolvePostgresSsl("db.example.com", "required"), true);
  assert.equal(resolvePostgresSsl("db.example.com", "disable"), false);
  assert.throws(() => resolvePostgresSsl("db.example.com", undefined), /POSTGRES_SSL/);
});
