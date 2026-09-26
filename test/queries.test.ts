import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLibrary,
  createRecord,
  defaultLibraryId,
  deleteLibrary,
  deleteRecord,
  getLibrary,
  getRecord,
  listRecords,
  lookupItems,
} from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";

test("shared store: two actors see the same records", async () => {
  await withTestDatabase(async (db) => {
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
  });
});

test("items stay inside their library", async () => {
  await withTestDatabase(async (db) => {
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
  });
});

test("reader queries return published items in one library only", async () => {
  await withTestDatabase(async (db) => {
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
  });
});

test("one lookup by library name returns the matching item", async () => {
  await withTestDatabase(async (db) => {
    const locations = await createLibrary(db, "Organization Locations and Hours", "alice");
    const cedar = await createRecord(
      db,
      {
        title: "Cedar Bend Office",
        notes: "Weekday desk.\n\nAddress: 12 Cedar Bend\nPhone: (555) 010-2101",
        tags: [],
      },
      "alice",
      locations.id,
    );
    await createRecord(
      db,
      { title: "Glass Harbor Desk", notes: "Harbor desk.\n\nPhone: (555) 010-2102", tags: [] },
      "alice",
      locations.id,
    );
    await db.run("UPDATE items SET status = 'published' WHERE library_id = ?", locations.id);

    const hit = await lookupItems(
      db,
      { library_name: "locations", q: "what is the phone for cedar bend" },
      { publishedOnly: true },
    );
    assert.equal(hit.kind, "item");
    if (hit.kind === "item") {
      assert.equal(hit.item.id, cedar.id);
      assert.match(hit.item.notes, /555\) 010-2101/);
    }

    const vague = await lookupItems(
      db,
      { library_name: "Organization Locations and Hours", q: "phone" },
      { publishedOnly: true },
    );
    assert.equal(vague.kind, "list");

    const draft = await createRecord(
      db,
      { title: "Secret Annex", notes: "Draft only.\n\nPhone: (555) 010-9999", tags: [] },
      "alice",
      locations.id,
    );
    const hidden = await lookupItems(
      db,
      { library_name: "Organization Locations and Hours", q: "secret annex" },
      { publishedOnly: true },
    );
    assert.equal(hidden.kind, "none");
    const visibleToEditor = await lookupItems(
      db,
      { library_id: locations.id, q: "secret annex" },
      { publishedOnly: false },
    );
    assert.equal(visibleToEditor.kind, "item");
    if (visibleToEditor.kind === "item") assert.equal(visibleToEditor.item.id, draft.id);
  });
});

test("deleting a library removes its items and keeps the last library", async () => {
  await withTestDatabase(async (db) => {
    const main = await defaultLibraryId(db);
    const extra = await createLibrary(db, "Temporary", "alice");
    const item = await createRecord(db, { title: "Gone", notes: "temp", tags: [] }, "alice", extra.id);
    const removed = await deleteLibrary(db, extra.id);
    assert.equal(removed, true);
    assert.equal(await getLibrary(db, extra.id), undefined);
    assert.equal(await getRecord(db, item.id, { publishedOnly: false }), undefined);
    await assert.rejects(() => deleteLibrary(db, main), /Keep at least one library/);
    assert.equal((await getLibrary(db, main))?.id, main);
  });
});
