/** Cancel a Pending publish request: restore the live version, or archive a new item. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  cancelPublishItem,
  cancelPublishItems,
  createItem,
  createLibrary,
  getItem,
  publishItem,
  updateItem,
} from "../src/db/queries.ts";
import type { LibraryRow } from "../src/db/models.ts";
import { noticeMessage } from "../src/http/pages/layout.ts";
import { itemPage } from "../src/http/pages/items.ts";
import { withTestDatabase } from "./db.ts";

const publisher = accessFromLibraryRole({
  sub: "alice",
  clientId: "test",
  libraryRole: "publisher",
});

function library(partial: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Windows patching",
    template: "general",
    writeMode: "reviewed",
    schema: { starter: "general", fields: [] },
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: null,
    fieldProposalUnreadable: false,
    connectTokenLast4: "aaaa",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

test("cancel notices name the outcome", () => {
  assert.match(noticeMessage("canceled"), /last published version/);
  assert.match(noticeMessage("canceled_new"), /Archived/);
});

test("a Pending item offers Cancel next to Publish", () => {
  const html = itemPage({
    access: publisher,
    csrf: "token",
    item: {
      id: "item-1",
      library_id: "11111111-1111-4111-8111-111111111111",
      name: "VPN",
      entity_key: null,
      labels: [],
      summary: "New",
      body: "Draft",
      status: "draft",
      details: null,
      published_snapshot: null,
      previous_published_snapshot: null,
      created_by: "alice",
      updated_by: "alice",
      created_at: 0,
      updated_at: 0,
    },
    library: library(),
    html: "<p>Draft</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(html, /action="\/items\/item-1\/cancel"/);
  assert.match(html, />Cancel</);
  assert.match(html, /move to Archives/);
});

test("cancel restores a live item and archives one that was never published", async () => {
  await withTestDatabase(async (db) => {
    const libraryRow = await createLibrary(db, "Patching", "alice");
    const live = await createItem(
      db,
      { name: "VPN", body: "Use company VPN", labels: ["remote"], summary: "Company VPN" },
      "alice",
      libraryRow.id,
    );
    await publishItem(db, live.id, "alice");
    await updateItem(
      db,
      live.id,
      { name: "VPN", body: "Use personal VPN", labels: ["remote"], summary: "Wrong VPN" },
      "alice",
    );
    const fresh = await createItem(
      db,
      { name: "Draft only", body: "Not ready", labels: [], summary: "Not ready" },
      "alice",
      libraryRow.id,
    );

    const bulk = await cancelPublishItems(db, libraryRow.id, [live.id, fresh.id, "missing"], "alice");
    assert.deepEqual(bulk.restored, [live.id]);
    assert.deepEqual(bulk.archived, [fresh.id]);

    const restored = await getItem(db, live.id, { publishedOnly: false });
    assert.equal(restored?.status, "published");
    assert.equal(restored?.body, "Use company VPN");
    assert.equal(restored?.summary, "Company VPN");
    assert.equal(restored?.published_snapshot?.body, "Use company VPN");

    const archived = await getItem(db, fresh.id, { publishedOnly: false });
    assert.equal(archived?.status, "archived");
    assert.equal(archived?.body, "Not ready");

    const again = await cancelPublishItem(db, live.id, "alice");
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.reason, "not_pending");
  });
});
