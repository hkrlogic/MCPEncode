import assert from "node:assert/strict";
import { test } from "node:test";
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
