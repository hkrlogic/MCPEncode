import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  approveFieldProposal,
  createLibrary,
  getLibrary,
  proposeField,
  proposeTable,
  rejectFieldProposal,
} from "../src/db/queries.ts";
import { MAX_LIBRARY_FIELDS, normalizeFieldProposal } from "../src/items/field-proposal.ts";
import { itemForLibrarySchema, schemaForStarter } from "../src/items/library-schema.ts";
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
    connectToken: "test-connect-token-cccccccccccccccccc",
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
