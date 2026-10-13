/** Review Lock: the last published copy stays live while an edit is Pending. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { applyMigrations } from "../src/db/migrate.ts";
import {
  archiveItem,
  cancelPublishItem,
  createItem,
  createLibrary,
  createShelf,
  getItem,
  getItemByEntityKey,
  listAudit,
  listItems,
  lookupItems,
  publishItem,
  restoreItem,
  revertToPublished,
  searchShelf,
  setLibraryShelf,
  setLibraryWriteMode,
  unpublishItem,
  updateItem,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { itemReviewBlock, PENDING_LIVE_BANNER } from "../src/http/pages/layout.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

const auth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "pub-1", role: "readonly" },
};

async function call(server: ReturnType<typeof buildMcpServer>, name: string, args: unknown): Promise<string> {
  const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return (result.content ?? []).map((part) => part.text).join("\n");
}

/** A published VPN item, then an edit that is Pending. */
async function pendingEdit(db: Database) {
  const library = await createLibrary(db, "Access", "alice");
  const item = await createItem(
    db,
    { name: "VPN", body: "Use the company VPN", labels: ["remote"], entity_key: "vpn" },
    "alice",
    library.id,
  );
  await publishItem(db, item.id, "alice");
  const edited = await updateItem(
    db,
    item.id,
    { name: "VPN", body: "Use the zebrafish tunnel instead", labels: ["remote", "draftlabel"] },
    "alice",
  );
  assert.equal(edited?.status, "draft");
  assert.equal(edited?.has_pending_changes, true);
  return { library, item };
}

const reader = { publishedOnly: true } as const;

test("readers keep the published copy while an edit is Pending", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    const opened = await getItem(db, item.id, { ...reader, libraryId: library.id });
    assert.equal(opened?.status, "published");
    assert.equal(opened?.body, "Use the company VPN");
    assert.deepEqual(opened?.labels, ["remote"]);
    assert.equal(opened?.has_pending_changes, undefined, "readers are not told about the edit");
    const keyed = await getItemByEntityKey(db, library.id, "vpn", reader);
    assert.equal(keyed?.body, "Use the company VPN");
    const listed = await listItems(db, { library_id: library.id }, reader);
    assert.deepEqual(listed.map((row) => [row.name, row.status, row.has_pending_changes]), [["VPN", "published", undefined]]);
    // Editors still see the draft on the working row.
    const working = await getItem(db, item.id, { publishedOnly: false });
    assert.equal(working?.body, "Use the zebrafish tunnel instead");
    const editorList = await listItems(db, { library_id: library.id }, { publishedOnly: false });
    assert.equal(editorList[0]?.status, "draft");
    assert.equal(editorList[0]?.has_pending_changes, true);
  });
});

test("publishing the edit replaces the live copy", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    const published = await publishItem(db, item.id, "alice");
    assert.equal(published?.status, "published");
    assert.equal(published?.has_pending_changes, false);
    const opened = await getItem(db, item.id, { ...reader, libraryId: library.id });
    assert.equal(opened?.body, "Use the zebrafish tunnel instead");
    const hit = await lookupItems(db, { library_id: library.id, q: "zebrafish tunnel" }, reader);
    assert.equal(hit.kind, "item");
  });
});

test("Cancel drops the edit and keeps the live copy; Revert keeps it live too", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    const cancelled = await cancelPublishItem(db, item.id, "alice");
    assert.ok(cancelled.ok);
    assert.equal(cancelled.item.status, "published");
    assert.equal(cancelled.item.body, "Use the company VPN");
    assert.equal(cancelled.item.has_pending_changes, false);

    await updateItem(db, item.id, { name: "VPN", body: "Second try draft", labels: [] }, "alice");
    const reverted = await revertToPublished(db, item.id, "alice");
    assert.ok(reverted.ok);
    assert.equal(reverted.item.body, "Use the company VPN");
    const opened = await getItem(db, item.id, { ...reader, libraryId: library.id });
    assert.equal(opened?.body, "Use the company VPN");
  });
});

test("a never-published item stays hidden; Unpublish, Archive and Restore still hide", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Access", "alice");
    const fresh = await createItem(db, { name: "New", body: "not yet", labels: [] }, "alice", library.id);
    assert.equal(await getItem(db, fresh.id, { ...reader, libraryId: library.id }), undefined);
    await updateItem(db, fresh.id, { name: "New", body: "still not", labels: [] }, "alice");
    assert.equal(await getItem(db, fresh.id, { ...reader, libraryId: library.id }), undefined);

    const { item } = await pendingEdit(db);
    const lib = (await getItem(db, item.id, { publishedOnly: false }))!.library_id;
    await publishItem(db, item.id, "alice");
    await unpublishItem(db, item.id, "alice");
    assert.equal(await getItem(db, item.id, { ...reader, libraryId: lib }), undefined);
    await publishItem(db, item.id, "alice");
    await updateItem(db, item.id, { name: "VPN", body: "edit", labels: [] }, "alice");
    await archiveItem(db, item.id, "alice");
    assert.equal(await getItem(db, item.id, { ...reader, libraryId: lib }), undefined);
    await restoreItem(db, item.id, "alice");
    assert.equal(await getItem(db, item.id, { ...reader, libraryId: lib }), undefined);
  });
});

test("search does not leak draft text to readers", async () => {
  await withTestDatabase(async (db) => {
    const { library } = await pendingEdit(db);
    assert.equal((await lookupItems(db, { library_id: library.id, q: "zebrafish tunnel" }, reader)).kind, "none");
    assert.equal((await listItems(db, { library_id: library.id, q: "draftlabel" }, reader)).length, 0);
    const live = await lookupItems(db, { library_id: library.id, q: "company VPN" }, reader);
    assert.equal(live.kind, "item");
    if (live.kind === "item") assert.equal(live.item.body, "Use the company VPN");

    const shelf = await createShelf(db, "Shelf", "alice");
    assert.ok(shelf.ok);
    if (!shelf.ok) return;
    await setLibraryShelf(db, library.id, shelf.shelf.id, "alice");
    const scope = { subject: "x", sa: false, includeLibraryId: library.id };
    assert.equal((await searchShelf(db, shelf.shelf.id, "draftlabel", scope)).length, 0);
    assert.equal((await searchShelf(db, shelf.shelf.id, "VPN", scope)).length, 1);
  });
});

test("MCP: Reader key sees the published copy; editors see status and can ask for the draft", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    const ctx = {
      libraryId: library.id,
      libraryName: library.name,
      libraryRole: "publisher" as const,
      idpRole: "readonly" as const,
      schema: library.schema,
      writeMode: library.writeMode,
    };
    const readerServer = buildMcpServer(db, auth, { ...ctx, libraryRole: "reader", readerKey: true });
    const readerOpen = await call(readerServer, "open_item", { id: item.id });
    assert.match(readerOpen, /Use the company VPN/);
    assert.doesNotMatch(readerOpen, /zebrafish|has_pending_changes|status:/);
    const readerDraft = await call(readerServer, "open_item", { id: item.id, version: "draft" });
    assert.doesNotMatch(readerDraft, /zebrafish/);
    assert.match(await call(readerServer, "list_items", { q: "zebrafish tunnel" }), /No matching item/);
    const readerList = await call(readerServer, "list_items", {});
    assert.doesNotMatch(readerList, /has_pending_changes|draftlabel/);

    const editor = buildMcpServer(db, auth, ctx);
    const editorOpen = await call(editor, "open_item", { id: item.id });
    assert.match(editorOpen, /status: published/);
    assert.match(editorOpen, /has_pending_changes: true/);
    assert.match(editorOpen, /version: published/);
    assert.match(editorOpen, /Use the company VPN/);
    const editorDraft = await call(editor, "open_item", { id: item.id, version: "draft" });
    assert.match(editorDraft, /status: draft/);
    assert.match(editorDraft, /version: draft/);
    assert.match(editorDraft, /zebrafish/);
    const editorList = JSON.parse(await call(editor, "list_items", {})) as {
      items: { status: string; has_pending_changes: boolean }[];
    };
    assert.deepEqual(editorList.items.map((row) => [row.status, row.has_pending_changes]), [["published", true]]);
    // Asking for the draft did not change what Readers see.
    assert.match(await call(readerServer, "open_item", { id: item.id }), /Use the company VPN/);
  });
});

test("Review Unlock still publishes directly", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Live", "alice");
    await setLibraryWriteMode(db, library.id, "direct", "alice");
    const item = await createItem(db, { name: "Rota", body: "Ann", labels: [] }, "alice", library.id, {
      status: "published",
    });
    const saved = await updateItem(db, item.id, { name: "Rota", body: "Bob", labels: [] }, "alice");
    assert.equal(saved?.status, "published");
    assert.equal(saved?.has_pending_changes, false);
    assert.equal((await getItem(db, item.id, { ...reader, libraryId: library.id }))?.body, "Bob");
  });
});

test("audit log records edit-pending, publish, discard and revert", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    await cancelPublishItem(db, item.id, "alice");
    await updateItem(db, item.id, { name: "VPN", body: "x", labels: [] }, "alice");
    await revertToPublished(db, item.id, "alice");
    await updateItem(db, item.id, { name: "VPN", body: "y", labels: [] }, "alice");
    await publishItem(db, item.id, "alice");
    const tools = (await listAudit(db, library.id)).map((row) => row.tool);
    for (const tool of [
      "item.edit_pending",
      "item.discard_pending",
      "item.revert_pending",
      "item.publish_replace_live",
      "item.publish",
    ]) {
      assert.ok(tools.includes(tool), `${tool} in ${tools.join(",")}`);
    }
  });
});

test("publisher item page shows the Pending-changes banner and the published copy", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await pendingEdit(db);
    const working = await getItem(db, item.id, { publishedOnly: false });
    assert.ok(working);
    const html = itemReviewBlock(working, library.schema);
    assert.ok(html.includes(PENDING_LIVE_BANNER));
    assert.match(html, /Use the company VPN/);
  });
});

test("migration backfill: edited-after-publish items go live again; others stay hidden", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Old", "alice");
    const mk = async (name: string) => {
      const row = await createItem(db, { name, body: `${name} live`, labels: [] }, "alice", library.id);
      await publishItem(db, row.id, "alice");
      return row.id;
    };
    const edited = await mk("Edited");
    const unpublished = await mk("Unpublished");
    const restored = await mk("Restored");
    const broken = await mk("Broken");
    const never = (await createItem(db, { name: "Never", body: "x", labels: [] }, "alice", library.id)).id;
    await updateItem(db, edited, { name: "Edited", body: "Edited draft", labels: [] }, "alice");
    await updateItem(db, broken, { name: "Broken", body: "Broken draft", labels: [] }, "alice");
    await unpublishItem(db, unpublished, "alice");
    await db.run(
      "INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at, library_id) VALUES (?, 'alice', 'ui.unpublish', true, ?, ?, ?)",
      crypto.randomUUID(),
      unpublished,
      Date.now(),
      library.id,
    );
    await archiveItem(db, restored, "alice");
    await restoreItem(db, restored, "alice");
    // Pretend the rows were written before 018: nothing is live while Pending.
    await db.run("UPDATE items SET published_live = false");
    await db.run("UPDATE items SET published_snapshot = '{not json' WHERE id = ?", broken);
    // Later migrations redefine items_live (021 adds aliases), so replay them in order too.
    await db.run("DROP VIEW items_live");
    await db.run(
      "DELETE FROM schema_migrations WHERE version IN ('018_published_while_pending.sql', '021_item_aliases.sql')",
    );
    await applyMigrations(db);

    const live = async (id: string) => (await getItem(db, id, { ...reader, libraryId: library.id }))?.body;
    assert.equal(await live(edited), "Edited live");
    assert.equal(await live(unpublished), undefined);
    assert.equal(await live(restored), undefined);
    assert.equal(await live(broken), undefined);
    assert.equal(await live(never), undefined);
  });
});
