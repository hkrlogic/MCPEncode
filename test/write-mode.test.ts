import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  addDraftItem,
  createLibrary,
  getLibrary,
  listItems,
  setLibraryWriteMode,
  updateItem,
} from "../src/db/queries.ts";
import { libraryPage } from "../src/http/pages.ts";
import { mcpWriteToolDescription, schemaForStarter } from "../src/items/library-schema.ts";
import { agentInstructions } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

test("reviewed libraries keep create and update as Pending", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Policy pack", "alice", "general", undefined, "reviewed");
    assert.equal(library.writeMode, "reviewed");

    const created = await addDraftItem(
      db,
      library.id,
      { name: "VPN rule", body: "Use the company VPN offsite." },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.item.status, "draft");

    const updated = await updateItem(
      db,
      created.item.id,
      { name: "VPN rule", body: "Use the company VPN offsite.\n\nAlways.", labels: [] },
      "alice",
    );
    assert.equal(updated?.status, "draft");

    const publishedOnly = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(publishedOnly.length, 0);
  });
});

test("direct libraries publish on create and stay live on update", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Patch scans", "alice", "general", undefined, "direct");
    assert.equal(library.writeMode, "direct");

    const created = await addDraftItem(
      db,
      library.id,
      { name: "CONTOSO-01", body: "Last scan clean." },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.item.status, "published");
    assert.ok(created.item.published_snapshot);

    const updated = await updateItem(
      db,
      created.item.id,
      { name: "CONTOSO-01", body: "Last scan: 2 updates pending.", labels: ["windows"] },
      "alice",
    );
    assert.equal(updated?.status, "published");
    assert.match(updated?.body ?? "", /2 updates pending/);

    const live = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(live.length, 1);
    assert.equal(live[0]?.name, "CONTOSO-01");
  });
});

test("switching to direct publishes on the next save only", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Ops board", "alice", "general", undefined, "reviewed");
    const created = await addDraftItem(
      db,
      library.id,
      { name: "Gateway A", body: "Offline" },
      "alice",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.item.status, "draft");

    const switched = await setLibraryWriteMode(db, library.id, "direct", "alice");
    assert.equal(switched?.writeMode, "direct");
    const stillPending = await listItems(db, { library_id: library.id }, { publishedOnly: false });
    assert.equal(stillPending[0]?.status, "draft");

    const updated = await updateItem(
      db,
      created.item.id,
      { name: "Gateway A", body: "Online", labels: [] },
      "alice",
    );
    assert.equal(updated?.status, "published");
  });
});

test("library page explains write mode to publishers only", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Live feed", "alice", "general", undefined, "direct");
    const fresh = await getLibrary(db, library.id);
    assert.ok(fresh);

    const publisher = accessFromLibraryRole({
      sub: "alice",
      clientId: "test",
      libraryRole: "publisher",
    });
    const reader = accessFromLibraryRole({
      sub: "bob",
      clientId: "test",
      libraryRole: "reader",
    });
    const shared = {
      csrf: "token",
      library: fresh,
      items: [],
      mcpUrl: "http://127.0.0.1:3000/libraries/x/mcp",
      shellLibraries: [],
    };
    const publisherHtml = libraryPage({ ...shared, access: publisher });
    assert.match(publisherHtml, /Direct/);
    assert.match(publisherHtml, /Saves are live immediately for readers and agents/);
    assert.match(publisherHtml, /Change to Reviewed/);
    assert.match(publisherHtml, /action="\/libraries\/[^"]+\/write-mode"/);

    const readerHtml = libraryPage({ ...shared, access: reader });
    assert.doesNotMatch(readerHtml, /Change to Reviewed/);
    assert.doesNotMatch(readerHtml, /write-mode/);
  });
});

test("direct agent instructions say saves are live", () => {
  const reviewed = agentInstructions("Policies", { starter: "policy", fields: [] }, "reviewed");
  assert.match(reviewed, /save drafts only/);
  assert.doesNotMatch(reviewed, /Collecting and storing for the next agent/);
  const direct = agentInstructions("Patch scans", { starter: "general", fields: [] }, "direct");
  assert.match(direct, /Direct/);
  assert.match(direct, /live immediately/);
  assert.match(direct, /Collecting and storing for the next agent/);
  assert.match(direct, /stable entity_key/);
  assert.match(direct, /list_items with entity_key/);
  assert.match(direct, /Prefer update over a second create/);
  assert.match(direct, /Summary must be a one-line handoff/);
  assert.match(direct, /Add useful labels/);
  assert.match(direct, /scooping agent/);
  assert.doesNotMatch(direct, /save drafts only/);
});

test("direct write tool descriptions teach search-then-upsert handoff", () => {
  const schema = schemaForStarter("general");
  const create = mcpWriteToolDescription(schema, "create", "direct");
  assert.match(create, /entity_key/);
  assert.match(create, /stable name/);
  assert.match(create, /one-line summary/);
  assert.match(create, /Prefer update_item/);
  const update = mcpWriteToolDescription(schema, "update", "direct");
  assert.match(update, /prefer entity_key/);
  assert.match(update, /next agent can scoop/);
  const reviewed = mcpWriteToolDescription(schema, "create", "reviewed");
  assert.match(reviewed, /Pending/);
  assert.match(reviewed, /entity_key/);
});
