import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole, ROLE_PERMISSIONS } from "../src/auth/rbac.ts";
import { createItem, createLibrary, listItems } from "../src/db/queries.ts";
import type { ItemRow, ItemSummary, LibraryRow } from "../src/db/models.ts";
import { publishDiff } from "../src/http/pages/layout.ts";
import { itemPage, librariesPage, libraryPage } from "../src/http/pages.ts";
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
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

const shell = {
  csrf: "token",
  mcpUrl: "http://127.0.0.1:3000/libraries/x/mcp",
  shellLibraries: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Windows patching",
      template: "general",
      access_role: "publisher",
      pendingCount: 2,
    },
  ],
};

test("home lists libraries that have items waiting to publish", () => {
  const html = librariesPage({
    access: { sub: "alice", clientId: "test", role: "edit", permissions: ROLE_PERMISSIONS.edit },
    csrf: "token",
    libraries: shell.shellLibraries,
  });
  assert.match(html, /These libraries have items waiting to publish/);
  assert.match(html, /3 pending|2 pending/);
  assert.match(html, /tab=pending/);
  assert.match(html, /class="sidebar-pending"/);
});

test("an empty library offers Add item, and search offers Clear", () => {
  const empty = libraryPage({
    ...shell,
    access: publisher,
    library: library(),
    items: [],
  });
  assert.match(empty, /No published items yet/);
  assert.match(empty, /class="empty-action"/);
  assert.match(empty, /Add item/);

  const searched = libraryPage({
    ...shell,
    access: publisher,
    library: library(),
    items: [],
    q: "missing",
  });
  assert.match(searched, /No items match\./);
  assert.match(searched, />Clear</);
  assert.doesNotMatch(searched, /class="empty-action"/);
});

test("a table library lists items as a grid of its short columns", () => {
  const roster = library({
    template: "table",
    schema: {
      starter: "table",
      tableName: "Roster",
      fields: [
        { key: "phone", label: "Phone", type: "text", required: true, kind: "control" },
        { key: "notes", label: "Notes", type: "longtext", required: false, kind: "body" },
      ],
    },
  });
  const items: ItemSummary[] = [
    {
      id: "item-1",
      library_id: roster.id,
      name: "Alex",
      entity_key: null,
      labels: [],
      summary: "Nights",
      status: "published",
      updated_at: 1,
      values: { phone: "555-0100", notes: "Bring the laptop" },
    },
  ];
  const html = libraryPage({ ...shell, access: publisher, library: roster, items });
  assert.match(html, /class="item-grid"/);
  assert.match(html, />Phone</);
  assert.match(html, /555-0100/);
  assert.match(html, /Alex/);
  assert.doesNotMatch(html, />Notes</);
  assert.doesNotMatch(html, /Bring the laptop/);
});

test("publish diff labels the previous and current text", () => {
  const item: ItemRow = {
    id: "item-1",
    library_id: "11111111-1111-4111-8111-111111111111",
    name: "Now name",
    entity_key: null,
    labels: [],
    summary: "now",
    body: "now body",
    status: "draft",
    details: null,
    published_snapshot: null,
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
  };
  const html = publishDiff(item, {
    name: "Then",
    labels: [],
    summary: "then",
    body: "then body",
    details: null,
    published_at: 1,
  });
  assert.match(html, />Published</);
  assert.match(html, />Now</);
  assert.match(html, /Then/);
  assert.match(html, /Now name/);
});

test("Edit sits with Publish, and Remove names the library", () => {
  const lib = library();
  const item = {
    id: "item-1",
    library_id: lib.id,
    name: "Patch Tuesday",
    entity_key: null,
    labels: [],
    summary: "Monthly",
    body: "Apply",
    status: "draft" as const,
    details: null,
    published_snapshot: null,
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
  };
  const html = itemPage({
    access: publisher,
    csrf: "token",
    item,
    library: lib,
    html: "<p>Apply</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  const editAt = html.indexOf('href="/items/item-1/edit"');
  const actionsAt = html.indexOf(">Actions<");
  assert.ok(editAt > 0);
  assert.ok(actionsAt > editAt);

  const access = libraryPage({
    ...shell,
    access: publisher,
    library: lib,
    items: [],
    tab: "access",
    viewerSub: "alice",
    accessList: [
      {
        library_id: lib.id,
        subject: "bob",
        role: "reader",
        granted_by: "alice",
        created_at: 0,
      },
    ],
  });
  assert.match(access, /id="viewer-sub"/);
  assert.match(access, /data-copy="#viewer-sub"/);
  assert.match(access, /A reader can look up published items/);
  assert.match(access, /Remove bob from Windows patching\?/);
});

test("table lists can include column values without changing the catalog list", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Roster", "alice", "general");
    await createItem(
      db,
      {
        name: "Alex",
        body: "row",
        labels: [],
        summary: "Nights",
        details: JSON.stringify({ _kind: "table", values: { phone: "555-0100" } }),
      },
      "alice",
      library.id,
      { status: "published" },
    );
    const withValues = await listItems(
      db,
      { library_id: library.id },
      { publishedOnly: true },
      { includeDetails: true },
    );
    assert.equal(withValues[0]?.values?.phone, "555-0100");
    const catalog = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(catalog[0]?.values, undefined);
  });
});
