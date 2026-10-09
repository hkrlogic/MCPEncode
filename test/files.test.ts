import assert from "node:assert/strict";
import { test } from "node:test";
import { addDraftItem, createLibrary, deleteItem, getItem, publishItem } from "../src/db/queries.ts";
import { addItemFile, getItemFile, listItemFiles, removeItemFile } from "../src/db/files.ts";
import { formatFileSize, sanitizeFileName, sniffFileType, MAX_FILE_BYTES } from "../src/items/files.ts";
import { labeledItemData } from "../src/markdown/render.ts";
import { withTestDatabase } from "./db.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");

test("sniff accepts pdf and png and rejects html", () => {
  assert.equal(sniffFileType(PDF), "application/pdf");
  assert.equal(sniffFileType(PNG), "image/png");
  assert.equal(sniffFileType(HTML), undefined);
  assert.equal(sniffFileType(Buffer.alloc(0)), undefined);
});

test("file names drop paths and keep the sniffed extension", () => {
  assert.equal(sanitizeFileName("../../policy.html", "application/pdf"), "policy.pdf");
  assert.equal(sanitizeFileName("shot.PNG", "image/png"), "shot.png");
  assert.equal(sanitizeFileName("", "image/jpeg"), "file.jpg");
  assert.equal(formatFileSize(1536), "2 KB");
});

test("a file is stored by name, capped at five, and dropped with the item", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Patching", "alice", "general");
    const created = await addDraftItem(
      db,
      library.id,
      { name: "Patch window", body: "Current window", summary: "Current window", labels: [] },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const html = await addItemFile(db, created.item.id, { filename: "evil.html", bytes: HTML }, "alice");
    assert.equal(html.ok, false);

    const saved = await addItemFile(db, created.item.id, { filename: "policy.pdf", bytes: PDF }, "alice");
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.file.name, "policy.pdf");
    assert.equal(saved.file.content_type, "application/pdf");
    assert.equal(saved.pending, false);

    const listed = await listItemFiles(db, created.item.id);
    assert.equal(listed.length, 1);
    assert.equal("bytes" in listed[0], false);

    const full = await getItemFile(db, created.item.id, saved.file.id);
    assert.ok(full);
    assert.equal(full?.bytes.equals(PDF), true);
    assert.equal(await getItemFile(db, "00000000-0000-4000-8000-000000000099", saved.file.id), undefined);

    const wire = labeledItemData({ ...created.item, files: listed });
    assert.match(wire, /files: \(names only — bytes are not included\)/);
    assert.match(wire, /policy\.pdf \(application\/pdf,/);
    assert.doesNotMatch(wire, /%PDF/);

    for (let i = 0; i < 4; i += 1) {
      const extra = await addItemFile(db, created.item.id, { filename: `p${i}.pdf`, bytes: PDF }, "alice");
      assert.equal(extra.ok, true);
    }
    const sixth = await addItemFile(db, created.item.id, { filename: "sixth.pdf", bytes: PDF }, "alice");
    assert.deepEqual(sixth, { ok: false, code: "too_many" });

    const huge = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    const over = await addItemFile(db, created.item.id, { filename: "big.pdf", bytes: huge }, "alice");
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.code, "too_big");

    assert.equal(await deleteItem(db, created.item.id), true);
    assert.equal((await listItemFiles(db, created.item.id)).length, 0);
  });
});

test("Review Lock moves a published item to Pending when a file is added or removed", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Standards", "alice", "general", undefined, "reviewed");
    const created = await addDraftItem(
      db,
      library.id,
      { name: "Window", body: "Saturday", summary: "Patch window", labels: [] },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const published = await publishItem(db, created.item.id, "alice");
    assert.equal(published?.status, "published");

    const saved = await addItemFile(db, created.item.id, { filename: "note.png", bytes: PNG }, "alice");
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.pending, true);
    assert.equal((await getItem(db, created.item.id, { publishedOnly: false }))?.status, "draft");

    const again = await publishItem(db, created.item.id, "alice");
    assert.equal(again?.status, "published");
    const removed = await removeItemFile(db, created.item.id, saved.file.id, "alice");
    assert.equal(removed.ok, true);
    if (!removed.ok) return;
    assert.equal(removed.pending, true);
    assert.equal((await getItem(db, created.item.id, { publishedOnly: false }))?.status, "draft");
  });
});
