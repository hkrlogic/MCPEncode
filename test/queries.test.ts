import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { createLibrary, createRecord, listRecords, getRecord, deleteRecord } from "../src/db/queries.ts";

test("shared store: two actors see the same records", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "test.db"));
  const created = await createRecord(
    db,
    { title: "Shared", notes: "hello **world**", tags: ["ops"] },
    "alice",
  );
  const listed = await listRecords(db, { tag: "ops" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "Shared");
  assert.equal(listed[0]?.excerpt.includes("hello"), true);
  const fetched = await getRecord(db, created.id);
  assert.equal(fetched?.created_by, "alice");
  const gone = await deleteRecord(db, created.id);
  assert.equal(gone, true);
  resetDatabaseCache();
});

test("items stay inside their library", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "test.db"));
  const patching = await createLibrary(db, "Windows patching", "alice");
  const coffee = await createLibrary(db, "Coffee run", "alice");
  await createRecord(db, { title: "Weekly rings", notes: "Prod Thursday", tags: [] }, "alice", patching.id);
  await createRecord(db, { title: "Order", notes: "Coffee 2", tags: [] }, "alice", coffee.id);
  const inPatching = await listRecords(db, { library_id: patching.id });
  const inCoffee = await listRecords(db, { library_id: coffee.id });
  assert.deepEqual(
    inPatching.map((row) => row.title),
    ["Weekly rings"],
  );
  assert.deepEqual(
    inCoffee.map((row) => row.title),
    ["Order"],
  );
  resetDatabaseCache();
});
