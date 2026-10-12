/**
 * Multi-actor simulations for propose_field / Approve / write paths.
 * Each test is one user story against a real throwaway database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  addDraftItem,
  approveFieldProposal,
  createLibrary,
  getItem,
  getLibrary,
  grantLibraryAccess,
  listItems,
  proposeField,
  proposeTable,
  rejectFieldProposal,
  rejectTableProposal,
} from "../src/db/queries.ts";
import { MAX_LIBRARY_FIELDS } from "../src/items/field-proposal.ts";
import { valuesForSchemaEdit } from "../src/items/table-proposal.ts";
import { libraryPage } from "../src/http/pages/libraries.ts";
import {
  buildMcpServer,
  resolveLibraryMcpAccess,
  type LibraryMcpContext,
} from "../src/mcp/server.ts";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { withTestDatabase } from "./db.ts";

function authFor(role: "sa" | "readonly", sub = "actor"): AuthInfo {
  return {
    token: "test",
    clientId: "test-client",
    scopes: role === "sa" ? ["openid", "mcpencode:edit", "mcpencode:sa"] : ["openid", "mcpencode:readonly"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { sub, role },
  };
}

function toolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(tools);
}

async function mcpCtx(
  db: Parameters<typeof resolveLibraryMcpAccess>[0],
  libraryId: string,
  sub: string,
): Promise<LibraryMcpContext> {
  const resolved = await resolveLibraryMcpAccess(db, authFor("readonly", sub), libraryId);
  assert.ok(!("error" in resolved), `expected MCP access for ${sub}`);
  return resolved;
}

test("Story A — agent proposes, publisher Approves, agent writes item", async () => {
  await withTestDatabase(async (db) => {
    // Sam creates the library (SA path via createLibrary grant).
    const library = await createLibrary(db, "Service tickets", "sam", "general", undefined, "reviewed");
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "casey",
      role: "publisher",
      grantedBy: "sam",
    });

    const caseyCtx = await mcpCtx(db, library.id, "casey");
    const caseyTools = toolNames(buildMcpServer(db, authFor("readonly", "casey"), caseyCtx));
    assert.ok(caseyTools.includes("propose_field"));
    assert.equal(caseyTools.includes("approve_field"), false);

    // Casey (agent session) proposes; Sam Approves in the publisher.
    const proposed = await proposeField(db, library.id, { label: "Priority", type: "text" }, "casey");
    assert.equal(proposed.ok, true);
    const approved = await approveFieldProposal(db, library.id, "sam");
    assert.equal(approved.ok, true);

    const live = await getLibrary(db, library.id);
    assert.ok(live?.schema.fields.some((field) => field.key === "priority"));

    const written = await addDraftItem(
      db,
      library.id,
      { name: "Printer jam", summary: "Floor 2 cannot print", body: "Needs toner", priority: "High" },
      "casey",
    );
    assert.equal(written.ok, true);
    if (!written.ok) return;
    assert.equal(written.item.status, "draft");
    assert.match(written.item.body, /Priority:\s*High/);

    // Readers only see published — Pending stays hidden.
    const published = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(published.length, 0);
  });
});

test("Story B — reader cannot propose or see the Approve panel", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "HR policies", "sam", "policy");
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "riley",
      role: "reader",
      grantedBy: "sam",
    });

    const riley = await resolveLibraryMcpAccess(db, authFor("readonly", "riley"), library.id);
    assert.ok(!("error" in riley));
    const tools = toolNames(buildMcpServer(db, authFor("readonly", "riley"), riley));
    assert.equal(tools.includes("propose_field"), false);
    assert.equal(tools.includes("create_item"), false);

    await proposeField(db, library.id, { label: "Audience", type: "longtext" }, "sam");
    const waiting = await getLibrary(db, library.id);
    const readerAccess = accessFromLibraryRole({
      sub: "riley",
      clientId: "test",
      libraryRole: "reader",
    });
    const html = libraryPage({
      access: readerAccess,
      csrf: "token",
      library: waiting!,
      items: [],
      mcpUrl: "http://127.0.0.1:3000/mcp",
      shellLibraries: [],
    });
    assert.doesNotMatch(html, /Field waiting for approval/);
    assert.doesNotMatch(html, /field\/approve/);
  });
});

test("Story C — two publishers: only one proposal waits; the other Approves", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Assets", "alice", "general");
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "bob",
      role: "publisher",
      grantedBy: "alice",
    });

    const fromAlice = await proposeField(db, library.id, { label: "Owner team", type: "text" }, "alice");
    assert.equal(fromAlice.ok, true);
    const fromBob = await proposeField(db, library.id, { label: "Serial", type: "text" }, "bob");
    assert.equal(fromBob.ok, false, "second proposal must wait");

    // Bob Approves Alice's proposal (human gate, either publisher).
    assert.equal((await approveFieldProposal(db, library.id, "bob")).ok, true);
    const live = await getLibrary(db, library.id);
    assert.ok(live?.schema.fields.some((field) => field.key === "owner_team"));
    assert.equal(live?.schema.fields.some((field) => field.key === "serial"), false);

    // Now Bob can propose Serial; Alice Rejects it.
    assert.equal((await proposeField(db, library.id, { label: "Serial", type: "text" }, "bob")).ok, true);
    assert.equal(await rejectFieldProposal(db, library.id, "alice"), true);
    assert.equal((await getLibrary(db, library.id))?.fieldProposal, null);
  });
});

test("Story D — Documents item written before field add keeps body on edit seed", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "sam", "general");
    const before = await addDraftItem(
      db,
      library.id,
      { name: "VPN", body: "## Connect\n\nUse the client." },
      "sam",
    );
    assert.equal(before.ok, true);
    if (!before.ok) return;

    assert.equal((await proposeField(db, library.id, { label: "System", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    const live = await getLibrary(db, library.id);
    const item = await getItem(db, before.item.id, { publishedOnly: false, libraryId: library.id });
    assert.ok(item);

    const seed = valuesForSchemaEdit(item!, live!.schema);
    assert.equal(seed.body, "## Connect\n\nUse the client.");
    assert.equal(seed.system, undefined);
  });
});

test("Story E — Policy guide grows once, then hits the 12-field cap", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Acceptable use", "sam", "policy");
    assert.equal(library.schema.fields.length, 11);

    assert.equal((await proposeField(db, library.id, { label: "Audience", type: "longtext" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    const live = await getLibrary(db, library.id);
    assert.equal(live?.schema.fields.length, MAX_LIBRARY_FIELDS);

    const blocked = await proposeField(db, library.id, { label: "Penalty", type: "text" }, "sam");
    assert.equal(blocked.ok, false);

    // Existing Policy keys are still required on write; Audience stays optional.
    const item = await addDraftItem(
      db,
      library.id,
      {
        name: "AUP",
        summary: "Staff internet use",
        owner: "Legal",
        version: "1.0",
        effective_date: "2026-01-01",
        review_date: "2027-01-01",
        purpose: "Set expectations",
        scope: "All staff",
        policy: "Do not share credentials.",
        audience: "Contractors included",
      },
      "sam",
    );
    assert.equal(item.ok, true);
    if (!item.ok) return;
    assert.match(item.item.body, /Audience:\nContractors included/);
  });
});

test("Story F — Review Unlock: approved field, save is live for readers", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Live inventory", "morgan", "general", undefined, "direct");
    assert.equal(library.writeMode, "direct");

    assert.equal((await proposeField(db, library.id, { label: "Site", type: "text" }, "morgan")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "morgan")).ok, true);

    const saved = await addDraftItem(
      db,
      library.id,
      {
        name: "host:lab-01",
        summary: "Lab workstation",
        body: "Ubuntu LTS",
        entity_key: "host:lab-01",
        site: "Building A",
      },
      "morgan",
    );
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.item.status, "published");

    const visible = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.name, "host:lab-01");
  });
});

test("Story G — table proposal and field proposal cannot both wait", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Ops board", "sam", "general");

    assert.equal(
      (
        await proposeTable(
          db,
          library.id,
          { name: "On-call", columns: [{ label: "Phone", type: "text", required: true }] },
          "sam",
        )
      ).ok,
      true,
    );
    assert.equal((await proposeField(db, library.id, { label: "Region", type: "text" }, "sam")).ok, false);

    assert.equal(await rejectTableProposal(db, library.id, "sam"), true);
    assert.equal((await proposeField(db, library.id, { label: "Region", type: "text" }, "sam")).ok, true);
    assert.equal(
      (
        await proposeTable(
          db,
          library.id,
          { name: "On-call", columns: [{ label: "Phone", type: "text", required: true }] },
          "sam",
        )
      ).ok,
      false,
    );
  });
});

test("Story H — wrong shape stays locked; fork path is new library (template-only story)", async () => {
  await withTestDatabase(async (db) => {
    const original = await createLibrary(db, "Tickets v1", "sam", "general");
    assert.equal((await proposeField(db, original.id, { label: "Priority", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, original.id, "sam")).ok, true);

    // No rename API — "changing" Priority means a new library seeded from the guide.
    const fork = await createLibrary(db, "Tickets v2", "sam", "general");
    assert.equal(fork.id === original.id, false);
    assert.equal(fork.schema.fields.some((field) => field.key === "priority"), false);
    assert.equal(
      (await getLibrary(db, original.id))?.schema.fields.some((field) => field.key === "priority"),
      true,
    );

    // On the fork, Sam can choose a different add-on at inception of growth.
    assert.equal((await proposeField(db, fork.id, { label: "Severity", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, fork.id, "sam")).ok, true);
    assert.ok((await getLibrary(db, fork.id))?.schema.fields.some((field) => field.key === "severity"));
  });
});
