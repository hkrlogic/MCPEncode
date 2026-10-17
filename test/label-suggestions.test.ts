/** Search words as labels, and agent label suggestions under Review Lock / Unlock. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { citationsFor } from "../src/db/citations.ts";
import { plannedLabels } from "../src/db/label-suggestions.ts";
import {
  cancelPublishItem,
  createItem,
  createLibrary,
  getItem,
  getLibrary,
  listAudit,
  lookupItems,
  publishItem,
  updateItem,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { itemReview } from "../src/items/review.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

const auth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "agent-1", role: "readonly" },
};

const reader = { publishedOnly: true } as const;

async function tools(db: Database, libraryId: string, role: "publisher" | "reader") {
  const library = await getLibrary(db, libraryId);
  assert.ok(library);
  const server = buildMcpServer(db, auth, {
    libraryId: library.id,
    libraryName: library.name,
    libraryRole: role,
    idpRole: "readonly",
    schema: library.schema,
    writeMode: library.writeMode,
  });
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

async function call(db: Database, libraryId: string, name: string, args: unknown) {
  const tool = (await tools(db, libraryId, "publisher"))[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: (result.content ?? []).map((part) => part.text).join("\n") };
}

async function seedRunbooks(db: Database, writeMode: "reviewed" | "direct" = "reviewed") {
  const library = await createLibrary(db, "Help Desk", "alice", "general", undefined, writeMode);
  const make = async (name: string, body: string, labels: string[]) => {
    const row = await createItem(db, { name, body, labels }, "alice", library.id);
    if (row.status !== "published") await publishItem(db, row.id, "alice");
    return row.id;
  };
  const incident = await make(
    "Incident Response Runbook",
    "Contain, eradicate and recover from a security incident. Isolate the host first.",
    ["runbook", "security"],
  );
  const remote = await make(
    "Remote Access Policy",
    "Staff connect to internal systems through the company VPN with MFA.",
    ["policy"],
  );
  await make("Printer Queue Reset", "Clear a stuck Windows print queue.", ["runbook", "printing"]);
  return { libraryId: library.id, incident, remote };
}

const PHISHED = "we think we got phished, what do we do";

test("search words are plain labels: matched, ranked and typo-tolerant", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, incident, remote } = await seedRunbooks(db);
    // Before the labels nothing in the library says "phished".
    assert.equal((await lookupItems(db, { library_id: libraryId, q: PHISHED }, reader)).kind, "none");

    const row = await getItem(db, incident, { publishedOnly: false });
    assert.ok(row);
    await updateItem(db, incident, { name: row.name, body: row.body, labels: [...row.labels, "phished", "phishing", "suspicious email"] }, "alice");
    await publishItem(db, incident, "alice");
    const r = await getItem(db, remote, { publishedOnly: false });
    assert.ok(r);
    await updateItem(db, remote, { name: r.name, body: r.body, labels: [...r.labels, "office network", "work from home", "wfh"] }, "alice");
    await publishItem(db, remote, "alice");

    const hit = await lookupItems(db, { library_id: libraryId, q: PHISHED }, reader);
    assert.equal(hit.kind, "item");
    assert.equal(hit.kind === "item" && hit.item.id, incident);

    const office = await lookupItems(db, { library_id: libraryId, q: "can't reach the office network from home" }, reader);
    assert.equal(office.kind, "item");
    assert.equal(office.kind === "item" && office.item.id, remote);

    // Multi-word labels match too.
    const email = await lookupItems(db, { library_id: libraryId, q: "suspicious email" }, reader);
    assert.equal(email.kind === "item" && email.item.id, incident);

    // A typo against a label word is corrected from the library's vocabulary.
    const typo = await lookupItems(db, { library_id: libraryId, q: "phisshed" }, reader);
    assert.equal(typo.kind, "item");
    assert.equal(typo.kind === "item" && typo.item.id, incident);
    assert.equal(typo.kind === "item" && typo.corrected, "phished");

    // Readers see the labels on the item they open.
    const opened = await getItem(db, incident, { ...reader, libraryId });
    assert.deepEqual(opened?.labels, ["runbook", "security", "phished", "phishing", "suspicious email"]);
  });
});

test("suggest_labels under Review Lock: Pending until a person publishes; Readers keep the old copy", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, incident } = await seedRunbooks(db);
    const before = await getItem(db, incident, { publishedOnly: false });
    assert.ok(before);

    const res = await call(db, libraryId, "suggest_labels", {
      id: incident,
      add_labels: ["Phished", "phishing", "suspicious email", "phished"],
      reason: PHISHED,
    });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Pending/);

    const working = await getItem(db, incident, { publishedOnly: false });
    assert.ok(working);
    assert.equal(working.status, "draft");
    assert.deepEqual(working.labels, ["runbook", "security", "phished", "phishing", "suspicious email"]);
    // Text untouched.
    assert.equal(working.name, before.name);
    assert.equal(working.summary, before.summary);
    assert.equal(working.body, before.body);

    // Review shows the label change only.
    const review = itemReview(working, working.published_snapshot, (await getLibrary(db, libraryId))!.schema);
    assert.equal(review.kind, "changed");
    assert.deepEqual(
      review.kind === "changed" ? review.fields.map((field) => field.label) : [],
      ["Labels"],
    );

    // Readers: still the published copy, and search does not use the pending labels.
    const live = await getItem(db, incident, { ...reader, libraryId });
    assert.deepEqual(live?.labels, ["runbook", "security"]);
    assert.equal((await lookupItems(db, { library_id: libraryId, q: PHISHED }, reader)).kind, "none");
    assert.equal((await citationsFor(db, [incident])).get(incident)?.version, 1);

    // A person approves.
    await publishItem(db, incident, "dana");
    const hit = await lookupItems(db, { library_id: libraryId, q: PHISHED }, reader);
    assert.equal(hit.kind === "item" && hit.item.id, incident);
    const cite = (await citationsFor(db, [incident])).get(incident);
    assert.equal(cite?.version, 2);

    const audit = await listAudit(db, libraryId, 50);
    const suggestion = audit.find((row) => row.tool === "suggest_labels" && row.success);
    assert.ok(suggestion, "suggestion is audited");
    assert.match(suggestion.detail, /phished/);
    assert.match(suggestion.detail, new RegExp(incident));
  });
});

test("rejecting a suggestion (Cancel) restores the published labels", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, incident } = await seedRunbooks(db);
    const res = await call(db, libraryId, "suggest_labels", { id: incident, add_labels: ["phished"], remove_labels: ["security"] });
    assert.equal(res.isError, false, res.text);
    const cancelled = await cancelPublishItem(db, incident, "dana");
    assert.equal(cancelled.ok, true);
    const row = await getItem(db, incident, { publishedOnly: false });
    assert.equal(row?.status, "published");
    assert.deepEqual(row?.labels, ["runbook", "security"]);
    assert.equal((await citationsFor(db, [incident])).get(incident)?.version, 1);
  });
});

test("suggest_labels under Review Unlock is live at once and bumps the published version", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, remote } = await seedRunbooks(db, "direct");
    const res = await call(db, libraryId, "suggest_labels", { id: remote, add_labels: ["office network", "wfh"] });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Review Unlock/);
    assert.match(res.text, /^labels: policy, office network, wfh$/m);
    assert.doesNotMatch(res.text, /aliases/);
    const live = await getItem(db, remote, { ...reader, libraryId });
    assert.deepEqual(live?.labels, ["policy", "office network", "wfh"]);
    assert.equal((await citationsFor(db, [remote])).get(remote)?.version, 2);
  });
});

test("suggest_labels refuses drafts, empty and stale requests; Readers do not get the tool", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, incident } = await seedRunbooks(db);
    const draft = await createItem(db, { name: "Draft", body: "x", labels: [] }, "alice", libraryId);
    const notLive = await call(db, libraryId, "suggest_labels", { id: draft.id, add_labels: ["x"] });
    assert.equal(notLive.isError, true);
    assert.match(notLive.text, /published items/);

    const empty = await call(db, libraryId, "suggest_labels", { id: incident });
    assert.equal(empty.isError, true);

    const stale = await call(db, libraryId, "suggest_labels", { id: incident, add_labels: ["x"], expected_revision: 1 });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Conflict/);

    const same = await call(db, libraryId, "suggest_labels", { id: incident, add_labels: ["runbook"] });
    assert.equal(same.isError, false);
    assert.match(same.text, /No change/);
    assert.equal((await getItem(db, incident, { publishedOnly: false }))?.status, "published");

    const readerTools = await tools(db, libraryId, "reader");
    assert.equal(readerTools.suggest_labels, undefined);
    assert.equal(readerTools.update_item, undefined);

    const failed = (await listAudit(db, libraryId, 50)).filter((row) => row.tool === "suggest_labels" && !row.success);
    assert.ok(failed.length >= 3);
  });
});

test("suggest_labels takes labels only", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId } = await seedRunbooks(db);
    const schema = (await tools(db, libraryId, "publisher")).suggest_labels as unknown as { inputSchema?: { shape?: Record<string, unknown> } };
    const keys = Object.keys(schema.inputSchema?.shape ?? {});
    assert.ok(keys.includes("add_labels"));
    assert.ok(!keys.some((key) => key.includes("alias")), keys.join(","));
  });
});

test("plannedLabels adds, removes and normalizes", () => {
  assert.deepEqual(
    plannedLabels({ labels: ["runbook", "Security"] }, { add_labels: [" Phishing ", "a,b"], remove_labels: ["security"] }),
    ["runbook", "phishing", "a b"],
  );
});

test("migration 026 merges aliases into labels (working row and published copy) without a new publish", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, incident } = await seedRunbooks(db);
    // Recreate the pre-026 shape: an aliases column and aliases in the published copy.
    await db.exec("ALTER TABLE items ADD COLUMN aliases JSONB NOT NULL DEFAULT '[]'::jsonb");
    const snap = JSON.parse(((await db.get("SELECT published_snapshot FROM items WHERE id = ?", incident)) as { published_snapshot: string }).published_snapshot);
    snap.aliases = ["Phished", "security", "suspicious email"];
    await db.run(
      "UPDATE items SET aliases = ?::jsonb, published_snapshot = ? WHERE id = ?",
      JSON.stringify(["Phished", "security", "suspicious email"]),
      JSON.stringify(snap),
      incident,
    );
    const versionBefore = (await citationsFor(db, [incident])).get(incident)?.version;

    await db.exec(await readFile(new URL("../migrations/026_aliases_into_labels.sql", import.meta.url), "utf8"));

    const row = await getItem(db, incident, { publishedOnly: false });
    assert.deepEqual(row?.labels, ["runbook", "security", "phished", "suspicious email"]);
    assert.deepEqual(row?.published_snapshot?.labels, ["runbook", "security", "phished", "suspicious email"]);
    const raw = (await db.get("SELECT published_snapshot FROM items WHERE id = ?", incident)) as { published_snapshot: string };
    assert.equal(JSON.parse(raw.published_snapshot).aliases, undefined);
    assert.equal((await citationsFor(db, [incident])).get(incident)?.version, versionBefore, "not a new publish");
    const columns = (await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('items', 'items_live') AND column_name = 'aliases'",
    )) as unknown[];
    assert.equal(columns.length, 0);
    const hit = await lookupItems(db, { library_id: libraryId, q: PHISHED }, reader);
    assert.equal(hit.kind === "item" && hit.item.id, incident);
  });
});
