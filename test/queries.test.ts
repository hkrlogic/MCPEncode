import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import {
  createLibrary,
  createRecord,
  defaultLibraryId,
  deleteRecord,
  getRecord,
  listRecords,
} from "../src/db/queries.ts";

test("shared store: two actors see the same records", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "test.db"));
  const created = await createRecord(
    db,
    { title: "Shared", notes: "hello **world**", tags: ["ops"] },
    "alice",
  );
  const libraryId = await defaultLibraryId(db);
  const listed = await listRecords(db, { library_id: libraryId, tag: "ops" }, { publishedOnly: false });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "Shared");
  assert.equal(listed[0]?.excerpt.includes("hello"), true);
  const fetched = await getRecord(db, created.id, { publishedOnly: false });
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
  const inPatching = await listRecords(db, { library_id: patching.id }, { publishedOnly: false });
  const inCoffee = await listRecords(db, { library_id: coffee.id }, { publishedOnly: false });
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

test("reader queries return published items in one library only", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "test.db"));
  const library = await createLibrary(db, "Windows patching", "alice");
  const other = await createLibrary(db, "Coffee run", "alice");
  const draft = await createRecord(db, { title: "Draft ring", notes: "not yet", tags: [] }, "alice", library.id);
  const live = await createRecord(db, { title: "Published ring", notes: "Thursday", tags: [] }, "alice", library.id);
  await createRecord(db, { title: "Other", notes: "Coffee", tags: [] }, "alice", other.id);
  await db.run("UPDATE items SET status = 'published' WHERE id = ?", live.id);

  await assert.rejects(() => listRecords(db, {}), /library_id is required/);
  const listed = await listRecords(db, { library_id: library.id }, { publishedOnly: true });
  assert.deepEqual(
    listed.map((row) => row.title),
    ["Published ring"],
  );
  const hidden = await getRecord(db, draft.id, { publishedOnly: true, libraryId: library.id });
  assert.equal(hidden, undefined);
  const opened = await getRecord(db, live.id, { publishedOnly: true, libraryId: library.id });
  assert.equal(opened?.title, "Published ring");
  const wrongLibrary = await getRecord(db, live.id, { publishedOnly: true, libraryId: other.id });
  assert.equal(wrongLibrary, undefined);
  resetDatabaseCache();
});
