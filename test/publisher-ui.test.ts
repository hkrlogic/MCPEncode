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
    connectToken: "test-connect-token-aaaaaaaaaaaaaaaaaa",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

const shell = {
  csrf: "token",
  mcpUrl: "http://127.0.0.1:3000/libraries/x/mcp/test-connect-token-aaaaaaaaaaaaaaaaaa",
  shellLibraries: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Windows patching",
      template: "general",
      writeMode: "reviewed" as const,
      access_role: "publisher",
      itemCount: 18,
      pendingCount: 2,
    },
  ],
};

test("home lists libraries that have items waiting to publish", () => {
  const html = librariesPage({
    access: { sub: "alice", clientId: "test", role: "sa", permissions: ROLE_PERMISSIONS.sa },
    csrf: "token",
    libraries: shell.shellLibraries,
  });
  assert.match(html, /These libraries have items waiting to publish/);
  assert.match(html, /3 pending|2 pending/);
  assert.match(html, /tab=pending/);
  assert.match(html, /class="sidebar-pending"/);
  assert.match(html, /class="sidebar-lib-count"/);
  assert.match(html, />18</);
  assert.match(html, /Review Lock/);
  assert.match(html, /href="\/libraries\/new"/);
  assert.doesNotMatch(html, /Table · Publisher/);
});

test("home idle state offers Add library when nothing is pending", () => {
  const html = librariesPage({
    access: { sub: "alice", clientId: "test", role: "sa", permissions: ROLE_PERMISSIONS.sa },
    csrf: "token",
    libraries: [{ ...shell.shellLibraries[0], pendingCount: 0 }],
  });
  assert.match(html, /Nothing waiting to publish/);
  assert.match(html, /Choose a library on the left/);
  assert.match(html, /href="\/libraries\/new"/);
  assert.match(html, />Add library</);
});

test("reader with no libraries sees Access guidance, not Add library", () => {
  const html = librariesPage({
    access: {
      sub: "bob",
      clientId: "test",
      role: "readonly",
      permissions: ROLE_PERMISSIONS.readonly,
    },
    csrf: "token",
    libraries: [],
  });
  assert.match(html, /No libraries assigned/);
  assert.match(html, /do not have Access/);
  assert.match(html, /grant you Access/);
  assert.doesNotMatch(html, /Add a library to get started/);
  assert.doesNotMatch(html, /href="\/libraries\/new"/);
  assert.match(html, /No libraries assigned\./);
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

test("a table library lists items by name and summary like every other library", () => {
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
  // List first: name + summary. Field values stay on the open item page.
  assert.match(html, /class="item-list"/);
  assert.match(html, /Alex/);
  assert.match(html, /Nights/);
  assert.doesNotMatch(html, /class="item-grid"/);
  assert.doesNotMatch(html, /555-0100/);
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

test("Edit and Archive live in Actions; Publish stays primary; only SA hard-deletes", () => {
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
  assert.match(html, /aria-label="Actions"/);
  assert.match(html, /href="\/items\/item-1\/export\.md"/);
  assert.match(html, /Export Markdown/);
  assert.ok(html.indexOf('href="/items/item-1/edit"') > 0);
  assert.match(html, /Changes since published/);
  assert.match(html, /id="publish-diff"/);
  assert.match(html, /Archive/);
  assert.match(html, /action="\/items\/item-1\/publish"/);
  assert.doesNotMatch(html, /class="btn secondary"[^>]*>Edit/);
  assert.doesNotMatch(html, /action="\/items\/item-1\/delete"/);

  const publishedHtml = itemPage({
    access: publisher,
    csrf: "token",
    item: { ...item, status: "published" },
    library: lib,
    html: "<p>Apply</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(publishedHtml, /Unpublish/);
  assert.match(publishedHtml, /Archive/);
  assert.doesNotMatch(publishedHtml, /action="\/items\/item-1\/publish"/);

  const saHtml = itemPage({
    access: {
      sub: "alice",
      clientId: "test",
      role: "sa",
      libraryRole: "publisher",
      permissions: ROLE_PERMISSIONS.sa,
    },
    csrf: "token",
    item,
    library: lib,
    html: "<p>Apply</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(saHtml, /aria-label="Actions"/);
  assert.match(saHtml, /action="\/items\/item-1\/delete"/);

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
  assert.match(access, /Remove bob from Windows patching\?/);

  const withPeople = libraryPage({
    ...shell,
    access: publisher,
    library: lib,
    items: [],
    tab: "access",
    viewerSub: "alice",
    accessList: [
      {
        library_id: lib.id,
        subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "reader",
        granted_by: "alice",
        created_at: 0,
      },
    ],
    accounts: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        username: "bob",
        role: "readonly",
        disabled: false,
      },
    ],
  });
  assert.match(withPeople, /Choose someone/);
  assert.match(withPeople, /name="username"/);
  assert.match(withPeople, /access-person-name">bob</);
  assert.doesNotMatch(withPeople, /viewer-sub/);
  assert.doesNotMatch(withPeople, /<code>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa<\/code>/);
  assert.match(withPeople, /Remove bob from Windows patching\?/);

  const libraryHtml = libraryPage({
    ...shell,
    access: publisher,
    library: lib,
    items: [],
  });
  assert.match(libraryHtml, /Rotate connect link/);
  assert.match(libraryHtml, /action="\/libraries\/[^"]+\/connect\/rotate"/);
  assert.match(libraryHtml, /Delete library/);
  assert.match(libraryHtml, /If this link leaks, rotate it under Actions/);
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
