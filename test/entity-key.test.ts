import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDraftItem,
  createLibrary,
  getItemByEntityKey,
  listItems,
  updateItem,
} from "../src/db/queries.ts";
import { labeledItemData } from "../src/markdown/render.ts";
import { isValidEntityKey, normalizeEntityKey } from "../src/items/schema.ts";
import { withTestDatabase } from "./db.ts";

test("normalizeEntityKey lowercases and blanks to null", () => {
  assert.equal(normalizeEntityKey("  Host:CONTOSO-01 "), "host:contoso-01");
  assert.equal(normalizeEntityKey("   "), null);
  assert.equal(isValidEntityKey("host:contoso-01"), true);
  assert.equal(isValidEntityKey("-bad"), false);
});

test("entity_key is unique per library and supports exact lookup", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Patch scans", "alice", "general", undefined, "direct");
    const created = await addDraftItem(
      db,
      library.id,
      {
        name: "Host CONTOSO-01",
        body: "Clean",
        entity_key: "host:contoso-01",
        labels: ["windows"],
      },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.item.entity_key, "host:contoso-01");
    assert.equal(created.item.status, "published");
    assert.match(labeledItemData(created.item), /entity_key: host:contoso-01/);

    const dup = await addDraftItem(
      db,
      library.id,
      {
        name: "Duplicate",
        body: "Nope",
        entity_key: "HOST:CONTOSO-01",
      },
      "alice",
    );
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.match(dup.message, /entity_key already exists/);

    const found = await getItemByEntityKey(db, library.id, "host:contoso-01", {
      publishedOnly: true,
    });
    assert.equal(found?.id, created.item.id);

    const listed = await listItems(
      db,
      { library_id: library.id, entity_key: "host:contoso-01" },
      { publishedOnly: true },
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.entity_key, "host:contoso-01");

    const updated = await updateItem(
      db,
      created.item.id,
      {
        name: "Host CONTOSO-01",
        body: "2 updates pending",
        labels: ["windows", "critical"],
      },
      "alice",
    );
    assert.equal(updated?.entity_key, "host:contoso-01");
    assert.match(updated?.body ?? "", /2 updates pending/);
  });
});

test("entity_key uniqueness is per library", async () => {
  await withTestDatabase(async (db) => {
    const a = await createLibrary(db, "A", "alice", "general", undefined, "direct");
    const b = await createLibrary(db, "B", "alice", "general", undefined, "direct");
    const first = await addDraftItem(
      db,
      a.id,
      { name: "Shared key", body: "A", entity_key: "shared" },
      "alice",
    );
    assert.equal(first.ok, true);
    const second = await addDraftItem(
      db,
      b.id,
      { name: "Shared key", body: "B", entity_key: "shared" },
      "alice",
    );
    assert.equal(second.ok, true);
  });
});
