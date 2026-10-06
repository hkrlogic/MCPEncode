import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  approveTableProposal,
  createItem,
  createLibrary,
  getLibrary,
  proposeTable,
  rejectTableProposal,
} from "../src/db/queries.ts";
import { itemForLibrarySchema, schemaForStarter } from "../src/items/library-schema.ts";
import { normalizeTableProposal } from "../src/items/table-proposal.ts";
import { libraryPage } from "../src/http/pages/libraries.ts";
import type { LibraryRow } from "../src/db/models.ts";
import { withTestDatabase } from "./db.ts";

const onCall = {
  name: "On-call roster",
  columns: [
    { label: "Phone", type: "text" as const, required: true },
    { label: "Shift", type: "text" as const, required: true },
    { label: "Notes", type: "longtext" as const, required: false },
  ],
  sample_rows: [{ Phone: "555-0100", Shift: "Nights", Notes: "Bring the laptop" }],
};

test("table proposals reject reserved names and bad sample dates", () => {
  const reserved = normalizeTableProposal({
    name: "Roster",
    columns: [{ label: "Name", type: "text", required: true }],
  });
  assert.equal(reserved.ok, false);

  const markup = normalizeTableProposal({
    name: "<script>",
    columns: [{ label: "Phone", type: "text", required: true }],
  });
  assert.equal(markup.ok, false);

  const badDate = normalizeTableProposal({
    name: "Roster",
    columns: [{ label: "When", type: "date", required: true }],
    sample_rows: [{ When: "tomorrow" }],
  });
  assert.equal(badDate.ok, false);
});

test("creating a library can store the confirmed table for approval", async () => {
  await withTestDatabase(async (db) => {
    const draft = normalizeTableProposal(onCall);
    assert.equal(draft.ok, true);
    if (!draft.ok) return;
    const library = await createLibrary(db, "Ops", "alice", "general", draft.draft);
    assert.equal(library.schema.starter, "general");
    assert.equal(library.tableProposal?.name, "On-call roster");
    assert.deepEqual(
      library.tableProposal?.columns.map((column) => column.label),
      ["Phone", "Shift", "Notes"],
    );
    await assert.rejects(() => createLibrary(db, "Policies", "alice", "policy", draft.draft));
  });
});

test("approve applies a proposed table only while the library has no items", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Ops", "alice", "general");
    const proposed = await proposeTable(db, library.id, onCall, "alice");
    assert.equal(proposed.ok, true);
    const again = await proposeTable(db, library.id, onCall, "alice");
    assert.equal(again.ok, false);

    const waiting = await getLibrary(db, library.id);
    assert.equal(waiting?.schema.starter, "general");
    assert.equal(waiting?.tableProposal?.name, "On-call roster");
    assert.equal(waiting?.tableProposal?.proposedBy, "alice");

    const approved = await approveTableProposal(db, library.id, "alice");
    assert.equal(approved.ok, true);
    const live = await getLibrary(db, library.id);
    assert.equal(live?.template, "table");
    assert.equal(live?.schema.starter, "table");
    assert.equal(live?.schema.tableName, "On-call roster");
    assert.equal(live?.tableProposal, null);
    assert.deepEqual(
      live?.schema.fields.map((field) => field.key),
      ["phone", "shift", "notes"],
    );

    const saved = itemForLibrarySchema(live!.schema, {
      name: "Alex",
      summary: "Nights this week",
      phone: "555-0100",
      shift: "Nights",
      notes: "Bring the laptop",
      purpose: "not a column",
    });
    assert.equal(saved.ok, false);

    const good = itemForLibrarySchema(live!.schema, {
      name: "Alex",
      summary: "Nights this week",
      phone: "555-0100",
      shift: "Nights",
      notes: "Bring the laptop",
    });
    assert.equal(good.ok, true);
    if (!good.ok) return;
    assert.match(good.item.body, /Table: On-call roster/);
    assert.match(good.item.details ?? "", /"_kind":"table"/);

    const occupied = await createLibrary(db, "Busy", "alice", "general");
    await proposeTable(db, occupied.id, onCall, "alice");
    const draft = itemForLibrarySchema(schemaForStarter("general"), {
      name: "Existing",
      body: "Already here",
      labels: [],
    });
    assert.equal(draft.ok, true);
    if (!draft.ok) return;
    await createItem(db, draft.item, "alice", occupied.id);
    const blocked = await approveTableProposal(db, occupied.id, "alice");
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, "has_items");
    const unchanged = await getLibrary(db, occupied.id);
    assert.equal(unchanged?.schema.starter, "general");
    assert.equal(unchanged?.tableProposal?.name, "On-call roster");

    const rejected = await rejectTableProposal(db, occupied.id, "alice");
    assert.equal(rejected, true);
    const cleared = await getLibrary(db, occupied.id);
    assert.equal(cleared?.tableProposal, null);
    assert.equal(cleared?.schema.starter, "general");
  });
});

test("the library page shows a proposal only to a publisher", () => {
  const proposal = normalizeTableProposal(onCall);
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const library: LibraryRow = {
    id: "00000000-0000-4000-8000-000000000099",
    name: "Ops",
    template: "general",
    writeMode: "reviewed",
    schema: schemaForStarter("general"),
    tableProposal: { ...proposal.draft, proposedBy: "mpos-editor", proposedAt: Date.UTC(2026, 9, 5, 16, 0) },
    tableProposalUnreadable: false,
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
    itemCount: 0,
  };
  const publisherHtml = libraryPage({ ...shared, access: publisher });
  assert.match(publisherHtml, /Table waiting for approval/);
  assert.match(publisherHtml, /On-call roster/);
  assert.match(publisherHtml, /Approve/);
  assert.match(publisherHtml, /555-0100/);
  assert.doesNotMatch(publisherHtml, /approve_table/);

  const readerHtml = libraryPage({ ...shared, access: reader });
  assert.doesNotMatch(readerHtml, /Table waiting for approval/);
  assert.doesNotMatch(readerHtml, /555-0100/);

  const blockedHtml = libraryPage({ ...shared, access: publisher, itemCount: 2 });
  assert.match(blockedHtml, /already has items/);
  assert.doesNotMatch(blockedHtml, /action="\/libraries\/[^"]+\/table\/approve"/);
});
