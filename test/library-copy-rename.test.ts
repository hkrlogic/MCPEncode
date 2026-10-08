import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  addDraftItem,
  approveFieldProposal,
  copyLibraryTemplate,
  countLibraryItems,
  createLibrary,
  getLibrary,
  listLibraryAccess,
  proposeField,
  renameLibrary,
  suggestedCopyName,
} from "../src/db/queries.ts";
import { libraryPage } from "../src/http/pages/libraries.ts";
import { withTestDatabase } from "./db.ts";

test("suggested copy name stays within the name limit", () => {
  assert.equal(suggestedCopyName("Ops"), "Ops copy");
  assert.equal(suggestedCopyName("  Tickets  "), "Tickets copy");
  const long = "A".repeat(200);
  assert.ok(suggestedCopyName(long).length <= 200);
});

test("rename library changes only the name", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Old name", "alice", "policy", undefined, "direct");
    const renamed = await renameLibrary(db, library.id, "New name", "alice");
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal(renamed.library.name, "New name");
    assert.equal(renamed.library.id, library.id);
    assert.equal(renamed.library.writeMode, "direct");
    assert.equal(renamed.library.template, "policy");
    assert.equal(renamed.library.connectToken, library.connectToken);
    assert.deepEqual(
      renamed.library.schema.fields.map((field) => field.key),
      library.schema.fields.map((field) => field.key),
    );

    const empty = await renameLibrary(db, library.id, "   ", "alice");
    assert.equal(empty.ok, false);
  });
});

test("copy library template seeds schema without items or source Access", async () => {
  await withTestDatabase(async (db) => {
    const source = await createLibrary(db, "Tickets", "alice", "general", undefined, "reviewed");
    assert.equal((await proposeField(db, source.id, { label: "Priority", type: "text" }, "alice")).ok, true);
    assert.equal((await approveFieldProposal(db, source.id, "alice")).ok, true);
    assert.equal(
      (
        await addDraftItem(
          db,
          source.id,
          { name: "T1", summary: "One", body: "Body", priority: "High" },
          "alice",
        )
      ).ok,
      true,
    );

    const copied = await copyLibraryTemplate(db, source.id, "Tickets copy", "bob");
    assert.equal(copied.ok, true);
    if (!copied.ok) return;

    assert.notEqual(copied.library.id, source.id);
    assert.notEqual(copied.library.connectToken, source.connectToken);
    assert.equal(copied.library.name, "Tickets copy");
    assert.equal(copied.library.writeMode, "reviewed");
    assert.equal(copied.library.template, "general");
    assert.ok(copied.library.schema.fields.some((field) => field.key === "priority"));
    assert.equal(copied.library.tableProposal, null);
    assert.equal(copied.library.fieldProposal, null);
    assert.equal(await countLibraryItems(db, copied.library.id), 0);
    assert.equal(await countLibraryItems(db, source.id), 1);

    const access = await listLibraryAccess(db, copied.library.id);
    assert.equal(access.length, 1);
    assert.equal(access[0]?.subject, "bob");
    assert.equal(access[0]?.role, "publisher");

    // Empty copy can still grow fields (add-only).
    assert.equal(
      (await proposeField(db, copied.library.id, { label: "Severity", type: "text" }, "bob")).ok,
      true,
    );
    assert.equal((await approveFieldProposal(db, copied.library.id, "bob")).ok, true);
    const grown = await getLibrary(db, copied.library.id);
    assert.ok(grown?.schema.fields.some((field) => field.key === "severity"));
    // Source unchanged by growth on the copy.
    assert.equal(
      (await getLibrary(db, source.id))?.schema.fields.some((field) => field.key === "severity"),
      false,
    );
  });
});

test("library page offers copy and rename only to publishers", () => {
  const library = {
    id: "00000000-0000-4000-8000-000000000077",
    name: "Docs",
    template: "general" as const,
    writeMode: "reviewed" as const,
    schema: { starter: "general" as const, fields: [] },
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: null,
    fieldProposalUnreadable: false,
    connectToken: "test-connect-token-dddddddddddddddddd",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
  };
  const publisher = accessFromLibraryRole({
    sub: "alice",
    clientId: "test",
    libraryRole: "publisher",
  });
  const reader = accessFromLibraryRole({
    sub: "riley",
    clientId: "test",
    libraryRole: "reader",
  });
  const shared = {
    csrf: "token",
    library,
    items: [],
    mcpUrl: "http://127.0.0.1:3000/mcp",
    shellLibraries: [],
  };
  const publisherHtml = libraryPage({ ...shared, access: publisher });
  assert.match(publisherHtml, /Copy library template/);
  assert.match(publisherHtml, /Rename library/);
  assert.match(publisherHtml, /action="\/libraries\/[^"]+\/copy"/);
  assert.match(publisherHtml, /action="\/libraries\/[^"]+\/rename"/);

  const readerHtml = libraryPage({ ...shared, access: reader });
  assert.doesNotMatch(readerHtml, /Copy library template/);
  assert.doesNotMatch(readerHtml, /Rename library/);
});
