import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  addDraftItem,
  approveFieldProposal,
  createLibrary,
  getLibrary,
  proposeField,
  proposeTable,
  rejectFieldProposal,
  rejectTableProposal,
} from "../src/db/queries.ts";
import {
  MAX_LIBRARY_FIELDS,
  normalizeFieldProposal,
  parseStoredFieldProposal,
} from "../src/items/field-proposal.ts";
import { itemForLibrarySchema, schemaForStarter } from "../src/items/library-schema.ts";
import { valuesForSchemaEdit } from "../src/items/table-proposal.ts";
import { libraryPage } from "../src/http/pages/libraries.ts";
import type { LibraryRow } from "../src/db/models.ts";
import { withTestDatabase } from "./db.ts";

test("field proposals reject reserved names and duplicates", () => {
  const schema = schemaForStarter("general");
  const reserved = normalizeFieldProposal({ label: "Name", type: "text" }, schema);
  assert.equal(reserved.ok, false);

  const bodyClash = normalizeFieldProposal({ label: "Body", type: "text" }, schema);
  assert.equal(bodyClash.ok, false);

  const ok = normalizeFieldProposal({ label: "Priority", type: "text" }, schema);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.draft.key, "priority");
  assert.equal(ok.draft.required, false);

  const dup = normalizeFieldProposal({ label: "Priority", type: "text" }, {
    ...schema,
    fields: [...schema.fields, { key: "priority", label: "Priority", type: "text", required: false, kind: "control" }],
  });
  assert.equal(dup.ok, false);
});

test("propose and approve append one optional field; second propose waits", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Tickets", "alice", "general");
    const proposed = await proposeField(db, library.id, { label: "Priority", type: "text" }, "alice");
    assert.equal(proposed.ok, true);
    const again = await proposeField(db, library.id, { label: "Severity", type: "text" }, "alice");
    assert.equal(again.ok, false);

    const waiting = await getLibrary(db, library.id);
    assert.equal(waiting?.fieldProposal?.label, "Priority");
    assert.equal(waiting?.schema.fields.some((field) => field.key === "priority"), false);

    const approved = await approveFieldProposal(db, library.id, "alice");
    assert.equal(approved.ok, true);
    const live = await getLibrary(db, library.id);
    assert.equal(live?.fieldProposal, null);
    assert.ok(live?.schema.fields.some((field) => field.key === "priority" && field.required === false));

    const saved = itemForLibrarySchema(live!.schema, {
      name: "Ticket 1",
      summary: "Network down",
      body: "Cannot reach VPN",
      priority: "High",
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.match(saved.item.body, /Priority:\s*High/);
  });
});

test("approve field works on policy libraries and reject clears the wait", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Policies", "alice", "policy");
    assert.ok(library.schema.fields.length < MAX_LIBRARY_FIELDS);

    const proposed = await proposeField(db, library.id, { label: "Audience", type: "longtext" }, "alice");
    assert.equal(proposed.ok, true);

    const rejected = await rejectFieldProposal(db, library.id, "alice");
    assert.equal(rejected, true);
    assert.equal((await getLibrary(db, library.id))?.fieldProposal, null);

    const again = await proposeField(db, library.id, { label: "Audience", type: "longtext" }, "alice");
    assert.equal(again.ok, true);
    const approved = await approveFieldProposal(db, library.id, "alice");
    assert.equal(approved.ok, true);
    const live = await getLibrary(db, library.id);
    assert.ok(live?.schema.fields.some((field) => field.key === "audience"));

    const item = itemForLibrarySchema(live!.schema, {
      name: "Remote access",
      summary: "Staff VPN rules",
      owner: "IT",
      version: "1.0",
      effective_date: "2026-01-01",
      review_date: "2027-01-01",
      purpose: "Protect remote access",
      scope: "All staff",
      policy: "Use the company VPN.",
      audience: "Contractors too",
    });
    assert.equal(item.ok, true);
    if (!item.ok) return;
    assert.match(item.item.body, /Audience:\nContractors too/);
  });
});

test("cannot propose a field while a table is waiting, and vice versa", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Ops", "alice", "general");
    const table = await proposeTable(
      db,
      library.id,
      {
        name: "Roster",
        columns: [{ label: "Phone", type: "text", required: true }],
      },
      "alice",
    );
    assert.equal(table.ok, true);
    const field = await proposeField(db, library.id, { label: "Site", type: "text" }, "alice");
    assert.equal(field.ok, false);

    assert.equal(await rejectTableProposal(db, library.id, "alice"), true);
    const fieldOk = await proposeField(db, library.id, { label: "Site", type: "text" }, "alice");
    assert.equal(fieldOk.ok, true);
    const tableBlocked = await proposeTable(
      db,
      library.id,
      {
        name: "Roster",
        columns: [{ label: "Phone", type: "text", required: true }],
      },
      "alice",
    );
    assert.equal(tableBlocked.ok, false);
  });
});

test("propose_field fails at the 12-field cap", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Full", "alice", "policy");
    // Policy starter has 11 fields; one add-on fills the cap.
    const first = await proposeField(db, library.id, { label: "Audience", type: "text" }, "alice");
    assert.equal(first.ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "alice")).ok, true);
    const live = await getLibrary(db, library.id);
    assert.equal(live?.schema.fields.length, MAX_LIBRARY_FIELDS);
    const blocked = await proposeField(db, library.id, { label: "Extra", type: "text" }, "alice");
    assert.equal(blocked.ok, false);
  });
});

test("stored proposals stay optional and reject markup in labels", () => {
  const dirty = parseStoredFieldProposal({
    key: "priority",
    label: "Priority",
    type: "text",
    required: true,
    proposedBy: "alice",
    proposedAt: 1,
  });
  assert.equal(dirty.unreadable, false);
  assert.equal(dirty.proposal?.required, false);

  const markup = parseStoredFieldProposal({
    key: "priority",
    label: "<script>",
    type: "text",
    proposedBy: "alice",
    proposedAt: 1,
  });
  assert.equal(markup.unreadable, true);
});

test("legacy Documents items keep body when the library gains fields", () => {
  const schema = {
    starter: "general" as const,
    fields: [
      { key: "body", label: "Description", type: "markdown" as const, required: false, kind: "body" as const },
      { key: "priority", label: "Priority", type: "text" as const, required: false, kind: "control" as const },
    ],
  };
  const values = valuesForSchemaEdit(
    { body: "## Old markdown\n\nKeep me.", details: null },
    schema,
  );
  assert.equal(values.body, "## Old markdown\n\nKeep me.");
  assert.equal(values.priority, undefined);
});

test("addDraftItem can save the approved optional field", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Tickets", "alice", "general");
    assert.equal(
      (await proposeField(db, library.id, { label: "Priority", type: "text" }, "alice")).ok,
      true,
    );
    assert.equal((await approveFieldProposal(db, library.id, "alice")).ok, true);
    const live = await getLibrary(db, library.id);
    const created = await addDraftItem(
      db,
      live!.id,
      {
        name: "Ticket 9",
        summary: "Printer jam",
        body: "Floor 2",
        priority: "Low",
      },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.match(created.item.body, /Priority:\s*Low/);
    assert.match(created.item.details ?? "", /"priority":"Low"/);
  });
});

test("the library page shows a field proposal only to a publisher", () => {
  const library: LibraryRow = {
    id: "00000000-0000-4000-8000-000000000088",
    name: "Docs",
    template: "general",
    writeMode: "reviewed",
    schema: schemaForStarter("general"),
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: {
      key: "priority",
      label: "Priority",
      type: "text",
      required: false,
      proposedBy: "mpos-editor",
      proposedAt: Date.UTC(2026, 9, 5, 16, 0),
    },
    fieldProposalUnreadable: false,
    connectTokenLast4: "cccc",
    created_by: "mpos-editor",
    updated_by: "mpos-editor",
    created_at: 0,
    updated_at: 0,
  };
  const publisher = accessFromLibraryRole({
    sub: "mpos-editor",
    clientId: "test",
    libraryRole: "publisher",
  });
  const reader = accessFromLibraryRole({
    sub: "mpos-reader",
    clientId: "test",
    libraryRole: "reader",
  });
  const shared = {
    csrf: "token",
    library,
    items: [],
    mcpUrl: "http://127.0.0.1:3000/libraries/x/mcp",
    shellLibraries: [],
  };
  const publisherHtml = libraryPage({ ...shared, access: publisher });
  assert.match(publisherHtml, /Field waiting for approval/);
  assert.match(publisherHtml, /Priority/);
  assert.match(publisherHtml, /field\/approve/);

  const readerHtml = libraryPage({ ...shared, access: reader });
  assert.doesNotMatch(readerHtml, /Field waiting for approval/);
});
