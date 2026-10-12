import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveItem,
  createLibrary,
  createItem,
  defaultLibraryId,
  deleteLibrary,
  deleteItem,
  getLibrary,
  getItem,
  listItems,
  lookupItems,
  publishItem,
  publishItems,
  restoreItem,
  unpublishItem,
  updateItem,
} from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";

test("shared store: two actors see the same records", async () => {
  await withTestDatabase(async (db) => {
    const created = await createItem(
      db,
      { name: "Shared", body: "hello **world**", labels: ["ops"] },
      "alice",
    );
    const libraryId = await defaultLibraryId(db);
    const listed = await listItems(db, { library_id: libraryId, label: "ops" }, { publishedOnly: false });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Shared");
    assert.equal(listed[0]?.summary.includes("hello"), true);
    assert.equal(listed[0]?.status, "draft");
    const fetched = await getItem(db, created.id, { publishedOnly: false });
    assert.equal(fetched?.created_by, "alice");
    assert.equal(fetched?.status, "draft");
    const gone = await deleteItem(db, created.id);
    assert.equal(gone, true);
  });
});

test("items stay inside their library", async () => {
  await withTestDatabase(async (db) => {
    const patching = await createLibrary(db, "Windows patching", "alice");
    const coffee = await createLibrary(db, "Coffee run", "alice");
    await createItem(db, { name: "Weekly rings", body: "Prod Thursday", labels: [] }, "alice", patching.id);
    await createItem(db, { name: "Order", body: "Coffee 2", labels: [] }, "alice", coffee.id);
    const inPatching = await listItems(db, { library_id: patching.id }, { publishedOnly: false });
    const inCoffee = await listItems(db, { library_id: coffee.id }, { publishedOnly: false });
    assert.deepEqual(
      inPatching.map((row) => row.name),
      ["Weekly rings"],
    );
    assert.deepEqual(
      inCoffee.map((row) => row.name),
      ["Order"],
    );
  });
});

test("reader queries return published items in one library only", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Windows patching", "alice");
    const other = await createLibrary(db, "Coffee run", "alice");
    const draft = await createItem(db, { name: "Draft ring", body: "not yet", labels: [] }, "alice", library.id);
    const live = await createItem(db, { name: "Published ring", body: "Thursday", labels: [] }, "alice", library.id);
    await createItem(db, { name: "Other", body: "Coffee", labels: [] }, "alice", other.id);
    const published = await publishItem(db, live.id, "alice");
    assert.equal(published?.status, "published");
    assert.ok(published?.published_snapshot);

    await assert.rejects(() => listItems(db, {}), /library_id is required/);
    const listed = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.deepEqual(
      listed.map((row) => row.name),
      ["Published ring"],
    );
    const hidden = await getItem(db, draft.id, { publishedOnly: true, libraryId: library.id });
    assert.equal(hidden, undefined);
    const opened = await getItem(db, live.id, { publishedOnly: true, libraryId: library.id });
    assert.equal(opened?.name, "Published ring");
    const wrongLibrary = await getItem(db, live.id, { publishedOnly: true, libraryId: other.id });
    assert.equal(wrongLibrary, undefined);
  });
});

test("edit stays Pending while readers keep the published copy; publish refreshes it", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Access", "alice");
    const item = await createItem(
      db,
      { name: "VPN", body: "Use company VPN", labels: ["remote"] },
      "alice",
      library.id,
    );
    await publishItem(db, item.id, "alice");
    const first = await getItem(db, item.id, { publishedOnly: false });
    assert.equal(first?.status, "published");
    assert.equal(first?.published_snapshot?.body, "Use company VPN");

    const edited = await updateItem(
      db,
      item.id,
      { name: "VPN", body: "Use company VPN on travel laptops", labels: ["remote"] },
      "alice",
    );
    assert.equal(edited?.status, "draft");
    assert.equal(edited?.published_snapshot?.body, "Use company VPN");
    const live = await getItem(db, item.id, { publishedOnly: true, libraryId: library.id });
    assert.equal(live?.body, "Use company VPN");

    const again = await publishItem(db, item.id, "alice");
    assert.equal(again?.status, "published");
    assert.equal(again?.published_snapshot?.body, "Use company VPN on travel laptops");
    const visible = await getItem(db, item.id, { publishedOnly: true, libraryId: library.id });
    assert.equal(visible?.body, "Use company VPN on travel laptops");
  });
});

test("unpublish archive and restore follow the gate", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Facilities", "alice");
    const item = await createItem(db, { name: "Lobby", body: "Front desk", labels: [] }, "alice", library.id);
    assert.equal((await publishItem(db, item.id, "alice"))?.status, "published");
    // Already published — publish again is refused.
    assert.equal(await publishItem(db, item.id, "alice"), undefined);

    const pending = await unpublishItem(db, item.id, "alice");
    assert.equal(pending?.status, "draft");
    assert.ok(pending?.published_snapshot);

    await publishItem(db, item.id, "alice");
    const archived = await archiveItem(db, item.id, "alice");
    assert.equal(archived?.status, "archived");
    assert.equal(await getItem(db, item.id, { publishedOnly: true, libraryId: library.id }), undefined);
    // Archived items cannot publish until restored.
    assert.equal(await publishItem(db, item.id, "alice"), undefined);

    const restored = await restoreItem(db, item.id, "alice");
    assert.equal(restored?.status, "draft");
    const live = await publishItem(db, restored!.id, "alice");
    assert.equal(live?.status, "published");
  });
});

test("bulk publish selects only Pending items in that library", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Contacts", "alice");
    const other = await createLibrary(db, "Other", "alice");
    const a = await createItem(db, { name: "Ann", body: "a@example.com", labels: [] }, "alice", library.id);
    const b = await createItem(db, { name: "Bob", body: "b@example.com", labels: [] }, "alice", library.id);
    const live = await createItem(db, { name: "Cara", body: "c@example.com", labels: [] }, "alice", library.id);
    await publishItem(db, live.id, "alice");
    const outsider = await createItem(db, { name: "Dan", body: "d@example.com", labels: [] }, "alice", other.id);

    const published = await publishItems(
      db,
      library.id,
      [a.id, b.id, live.id, outsider.id, "00000000-0000-4000-8000-000000000099"],
      "alice",
    );
    assert.deepEqual(published.sort(), [a.id, b.id].sort());
    assert.equal((await getItem(db, a.id, { publishedOnly: true, libraryId: library.id }))?.name, "Ann");
    assert.equal((await getItem(db, b.id, { publishedOnly: true, libraryId: library.id }))?.name, "Bob");
    assert.equal(await getItem(db, outsider.id, { publishedOnly: true, libraryId: other.id }), undefined);
  });
});

test("one lookup by library name returns the matching item", async () => {
  await withTestDatabase(async (db) => {
    const locations = await createLibrary(db, "Organization Locations and Hours", "alice");
    const cedar = await createItem(
      db,
      {
        name: "Cedar Bend Office",
        body: "Weekday desk.\n\nAddress: 12 Cedar Bend\nPhone: (555) 010-2101",
        labels: [],
      },
      "alice",
      locations.id,
    );
    await createItem(
      db,
      { name: "Glass Harbor Desk", body: "Harbor desk.\n\nPhone: (555) 010-2102", labels: [] },
      "alice",
      locations.id,
    );
    for (const row of await listItems(db, { library_id: locations.id }, { publishedOnly: false })) {
      await publishItem(db, row.id, "alice");
    }

    const hit = await lookupItems(
      db,
      { library_name: "locations", q: "what is the phone for cedar bend" },
      { publishedOnly: true },
    );
    assert.equal(hit.kind, "item");
    if (hit.kind === "item") {
      assert.equal(hit.item.id, cedar.id);
      assert.match(hit.item.body, /555\) 010-2101/);
    }

    const vague = await lookupItems(
      db,
      { library_name: "Organization Locations and Hours", q: "phone" },
      { publishedOnly: true },
    );
    assert.equal(vague.kind, "list");

    const draft = await createItem(
      db,
      { name: "Secret Annex", body: "Draft only.\n\nPhone: (555) 010-9999", labels: [] },
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

test("lookup uses whole words and does not read a fragment inside a longer word", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Facilities", "alice");
    const night = await createItem(
      db,
      { name: "Night desk", body: "Use the side door after hours.", labels: [] },
      "alice",
      library.id,
    );
    await createItem(
      db,
      { name: "Indoor plants", body: "Water the indoor plants on Friday.", labels: [] },
      "alice",
      library.id,
    );
    const handbook = await createItem(
      db,
      { name: "HR handbook", body: "People operations.", labels: [] },
      "alice",
      library.id,
    );
    await createItem(
      db,
      { name: "Dispatch roster", body: "Send the dispatch note.", labels: [] },
      "alice",
      library.id,
    );
    for (const row of await listItems(db, { library_id: library.id }, { publishedOnly: false })) {
      await publishItem(db, row.id, "alice");
    }

    const door = await lookupItems(db, { library_id: library.id, q: "where is the door" });
    assert.equal(door.kind, "item");
    if (door.kind === "item") assert.equal(door.item.id, night.id);

    const fragment = await lookupItems(db, { library_id: library.id, q: "patch" });
    assert.equal(fragment.kind, "none");

    const shortWord = await lookupItems(db, { library_id: library.id, q: "what is hr" });
    assert.equal(shortWord.kind, "item");
    if (shortWord.kind === "item") assert.equal(shortWord.item.id, handbook.id);
  });
});

test("deleting a library removes its items and keeps the last library", async () => {
  await withTestDatabase(async (db) => {
    const main = await defaultLibraryId(db);
    const extra = await createLibrary(db, "Temporary", "alice");
    const item = await createItem(db, { name: "Gone", body: "temp", labels: [] }, "alice", extra.id);
    await publishItem(db, item.id, "alice");
    const removed = await deleteLibrary(db, extra.id);
    assert.equal(removed, true);
    assert.equal(await getLibrary(db, extra.id), undefined);
    assert.equal(await getItem(db, item.id, { publishedOnly: false }), undefined);
    await assert.rejects(() => deleteLibrary(db, main), /Keep at least one library/);
    assert.equal((await getLibrary(db, main))?.id, main);
  });
});
