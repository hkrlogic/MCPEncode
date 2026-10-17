/** Review-by dates, stale citations, strict mode, the review queue and Still accurate. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { citationsFor } from "../src/db/citations.ts";
import {
  confirmStillAccurate,
  isPastReview,
  itemFreshness,
  reviewDaysFor,
  reviewQueue,
  setLibraryFreshness,
  setReviewBy,
  todayIso,
} from "../src/db/freshness.ts";
import { createItem, createLibrary, getItem, getLibrary, publishItem, updateItem } from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { reviewQueuePage } from "../src/http/pages/freshness.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

const auth: AuthInfo = {
  token: "t",
  clientId: "c",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "agent", role: "readonly" },
};

async function call(db: Database, libraryId: string, role: "reader" | "publisher", name: string, args: unknown) {
  const library = await getLibrary(db, libraryId);
  assert.ok(library);
  const server = buildMcpServer(
    db,
    auth,
    {
      libraryId: library.id,
      libraryName: library.name,
      libraryRole: role,
      idpRole: "readonly",
      schema: library.schema,
      writeMode: library.writeMode,
    },
    { publicBaseUrl: "http://app.test" },
  );
  const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, name);
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: (result.content ?? []).map((part) => part.text).join("\n") };
}

const day = (offset: number) => todayIso(Date.now() + offset * 86_400_000);

async function runbookLibrary(db: Database, template: "general" | "procedure" = "general") {
  const library = await createLibrary(db, "Runbooks", "alice", template);
  const row = await createItem(db, { name: "VPN Troubleshooting", body: "Restart the VPN client.", labels: [] }, "alice", library.id);
  await publishItem(db, row.id, "alice");
  return { libraryId: library.id, id: row.id };
}

test("type defaults: 90 days for Policy and Procedure, off for General; library setting overrides", async () => {
  assert.equal(reviewDaysFor({ template: "policy", reviewDays: null }), 90);
  assert.equal(reviewDaysFor({ template: "procedure", reviewDays: null }), 90);
  assert.equal(reviewDaysFor({ template: "general", reviewDays: null }), 0);
  assert.equal(reviewDaysFor({ template: "general", reviewDays: 30 }), 30);
  assert.equal(reviewDaysFor({ template: "policy", reviewDays: 0 }), 0);
  assert.equal(isPastReview(day(-1)), true);
  assert.equal(isPastReview(day(0)), false);
  assert.equal(isPastReview(null), false);

  await withTestDatabase(async (db) => {
    const procedure = await runbookLibrary(db, "procedure");
    assert.equal((await itemFreshness(db, procedure.id))?.reviewBy, day(90));
    const general = await runbookLibrary(db, "general");
    assert.equal((await itemFreshness(db, general.id))?.reviewBy, null);

    // Configured default applies on the next publish.
    await setLibraryFreshness(db, general.libraryId, { reviewDays: 30, strict: false }, "alice");
    const row = await getItem(db, general.id, { publishedOnly: false });
    assert.ok(row);
    await updateItem(db, general.id, { name: row.name, body: `${row.body} Then reconnect.`, labels: [] }, "alice");
    await publishItem(db, general.id, "alice");
    assert.equal((await itemFreshness(db, general.id))?.reviewBy, day(30));
  });
});

test("Policy items reuse their own Review date", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Policies", "alice", "policy");
    const details = JSON.stringify({ owner: "CISO", effective_date: "2026-01-01", review_date: "2027-03-31", policy: "Use MFA." });
    const row = await createItem(db, { name: "MFA", body: "Use MFA.", labels: [], details }, "alice", library.id);
    await publishItem(db, row.id, "alice");
    assert.equal((await itemFreshness(db, row.id))?.reviewBy, "2027-03-31");
    await setReviewBy(db, library.id, row.id, day(-3));
    const citation = (await citationsFor(db, [row.id])).get(row.id);
    assert.equal(citation?.owner, "CISO", "owner comes from the Policy owner field");
    assert.match(citation?.warning ?? "", /checking with CISO/);
  });
});

test("stale items carry review_by and a warning in list_items, open_item and citations", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, id } = await runbookLibrary(db, "procedure");
    const fresh = await call(db, libraryId, "reader", "open_item", { id });
    assert.match(fresh.text, new RegExp(`^review_by: ${day(90)}$`, "m"));
    assert.doesNotMatch(fresh.text, /stale:/);
    assert.doesNotMatch(fresh.text, /warning:/);

    await setReviewBy(db, libraryId, id, day(-5));
    const answer = await call(db, libraryId, "reader", "list_items", { q: "vpn" });
    assert.equal(answer.isError, false);
    assert.match(answer.text, new RegExp(`^warning: Past its review date \\(${day(-5)}\\); it may be out of date\\.`, "m"));
    const browse = JSON.parse((await call(db, libraryId, "reader", "list_items", {})).text);
    assert.equal(browse.items[0].citation.review_by, day(-5));
    assert.match(browse.items[0].citation.warning, /Past its review date/);
  });
});

test("strict mode refuses stale items and points to the owner; fresh items still answer", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, id } = await runbookLibrary(db, "procedure");
    const other = await createItem(db, { name: "VPN Client Install", body: "Install the client.", labels: [] }, "alice", libraryId);
    await publishItem(db, other.id, "alice");
    await setReviewBy(db, libraryId, id, day(-1));
    await setLibraryFreshness(db, libraryId, { reviewDays: null, strict: true }, "alice");

    const open = await call(db, libraryId, "reader", "open_item", { id });
    assert.equal(open.isError, true);
    assert.match(open.text, /^Refused: "VPN Troubleshooting" is past its review date/);
    assert.match(open.text, /ask the library owner to review it \(http:\/\/app\.test\/items\//);

    const single = await call(db, libraryId, "reader", "list_items", { q: "vpn troubleshooting" });
    assert.equal(single.isError, true);
    assert.match(single.text, /^Refused/);

    // A list keeps the fresh item and says one was withheld.
    const list = await call(db, libraryId, "reader", "list_items", { q: "vpn" });
    if (!list.isError && list.text.startsWith("{")) {
      const parsed = JSON.parse(list.text);
      assert.ok(parsed.items.every((item: { id: string }) => item.id !== id));
    } else {
      assert.match(list.text, /VPN Client Install/);
    }

    // Publishers reading the draft are not refused; published reads are.
    assert.equal((await call(db, libraryId, "publisher", "open_item", { id, version: "draft" })).isError, false);
    assert.equal((await call(db, libraryId, "publisher", "open_item", { id })).isError, true);

    // Strict off: answered again, with the warning.
    await setLibraryFreshness(db, libraryId, { reviewDays: null, strict: false }, "alice");
    const relaxed = await call(db, libraryId, "reader", "open_item", { id });
    assert.equal(relaxed.isError, false);
    assert.match(relaxed.text, /warning: Past its review date/);
  });
});

test("review queue lists due and overdue items; Still accurate clears it without a new version", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, id } = await runbookLibrary(db, "procedure");
    const later = await createItem(db, { name: "Printer", body: "Reset the queue.", labels: [] }, "alice", libraryId);
    await publishItem(db, later.id, "alice");
    const soon = await createItem(db, { name: "Laptop", body: "Image it.", labels: [] }, "alice", libraryId);
    await publishItem(db, soon.id, "alice");
    await setReviewBy(db, libraryId, id, day(-2));
    await setReviewBy(db, libraryId, soon.id, day(10));

    const queue = await reviewQueue(db, libraryId);
    assert.deepEqual(queue.map((row) => [row.name, row.overdue]), [
      ["VPN Troubleshooting", true],
      ["Laptop", false],
    ]);
    const library = await getLibrary(db, libraryId);
    assert.ok(library);
    const html = reviewQueuePage({ access: { sub: "alice" } as never, csrf: "x", library, queue });
    assert.match(html, /VPN Troubleshooting/);
    assert.match(html, /Overdue/);
    assert.match(html, new RegExp(`/items/${id}/still-accurate`));

    const before = await getItem(db, id, { publishedOnly: false });
    const versionBefore = (await citationsFor(db, [id])).get(id)?.version;
    const confirmed = await confirmStillAccurate(db, library, id, "dana");
    assert.equal(confirmed?.reviewBy, day(90));
    const after = await getItem(db, id, { publishedOnly: false });
    assert.equal(after?.updated_at, before?.updated_at, "revision unchanged");
    assert.equal(after?.body, before?.body);
    const citation = (await citationsFor(db, [id])).get(id);
    assert.equal(citation?.version, versionBefore, "citation version unchanged");
    assert.equal(citation?.stale, false);
    assert.deepEqual((await reviewQueue(db, libraryId)).map((row) => row.name), ["Laptop"]);
    const fresh = await itemFreshness(db, id);
    assert.ok(fresh?.reviewedAt);

    // Drafts that were never published cannot be confirmed.
    const draft = await createItem(db, { name: "Draft", body: "x", labels: [] }, "alice", libraryId);
    assert.equal(await confirmStillAccurate(db, library, draft.id, "dana"), undefined);
  });
});
