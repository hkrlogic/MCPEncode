/** Review-by dates, stale citations, the review queue and Still accurate. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { citationsFor } from "../src/db/citations.ts";
import {
  confirmStillAccurate,
  isPastReview,
  itemFreshness,
  reviewQueue,
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

test("publish sets review-by to +90 days in Policy and Procedure libraries, none elsewhere", async () => {
  assert.equal(isPastReview(day(-1)), true);
  assert.equal(isPastReview(day(0)), false);
  assert.equal(isPastReview(null), false);

  await withTestDatabase(async (db) => {
    const procedure = await runbookLibrary(db, "procedure");
    assert.equal((await itemFreshness(db, procedure.id))?.reviewBy, day(90));
    const general = await runbookLibrary(db, "general");
    assert.equal((await itemFreshness(db, general.id))?.reviewBy, null);

    // A date set by hand on a General item survives the next publish.
    await setReviewBy(db, general.libraryId, general.id, day(30));
    const row = await getItem(db, general.id, { publishedOnly: false });
    assert.ok(row);
    await updateItem(db, general.id, { name: row.name, body: `${row.body} Then reconnect.`, labels: [] }, "alice");
    await publishItem(db, general.id, "alice");
    assert.equal((await itemFreshness(db, general.id))?.reviewBy, day(30));

    // Libraries have no review period or strict-mode columns any more.
    const columns = (await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'libraries' AND column_name IN ('review_days', 'strict_freshness')",
    )) as unknown[];
    assert.equal(columns.length, 0);
  });
});

test("Policy items: review_by is the only review date; the owner field names who to ask", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Policies", "alice", "policy");
    assert.ok(!library.schema.fields.some((field) => field.key === "review_date"), "no Review date field");
    const details = JSON.stringify({ owner: "CISO", effective_date: "2026-01-01", policy: "Use MFA." });
    const row = await createItem(db, { name: "MFA", body: "Use MFA.", labels: [], details }, "alice", library.id);
    await publishItem(db, row.id, "alice");
    assert.equal((await itemFreshness(db, row.id))?.reviewBy, day(90));
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

test("stale items are still answered, with the warning (no strict mode)", async () => {
  await withTestDatabase(async (db) => {
    const { libraryId, id } = await runbookLibrary(db, "procedure");
    await setReviewBy(db, libraryId, id, day(-1));
    const open = await call(db, libraryId, "reader", "open_item", { id });
    assert.equal(open.isError, false);
    assert.match(open.text, /warning: Past its review date/);
    const single = await call(db, libraryId, "reader", "list_items", { q: "vpn troubleshooting" });
    assert.equal(single.isError, false);
    assert.doesNotMatch(single.text, /Refused|withheld/);
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
    const confirmed = await confirmStillAccurate(db, libraryId, id, "dana");
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
    assert.equal(await confirmStillAccurate(db, libraryId, draft.id, "dana"), undefined);
  });
});

test("migration 025 moves Policy review dates into review_by and drops the field without a new publish", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Policies", "alice", "policy");
    const schema = { ...library.schema, fields: [...library.schema.fields, { key: "review_date", label: "Review date", type: "date", required: true, kind: "control" }] };
    await db.run("UPDATE libraries SET schema = ?::jsonb WHERE id = ?", JSON.stringify(schema), library.id);
    const make = async (name: string) => {
      const details = JSON.stringify({ owner: "CISO", effective_date: "2026-01-01", review_date: "2027-03-31", policy: "Use MFA." });
      const row = await createItem(db, { name, body: "Use MFA.", labels: [], details }, "alice", library.id);
      await publishItem(db, row.id, "alice");
      const snap = JSON.parse(((await db.get("SELECT published_snapshot FROM items WHERE id = ?", row.id)) as { published_snapshot: string }).published_snapshot);
      snap.details = details;
      await db.run("UPDATE items SET published_snapshot = ?, details = ? WHERE id = ?", JSON.stringify(snap), details, row.id);
      return row.id;
    };
    const unset = await make("Unset");
    const confirmed = await make("Confirmed");
    await db.run("UPDATE items SET review_by = NULL WHERE id = ?", unset);
    await setReviewBy(db, library.id, confirmed, day(40));
    const versions = async () =>
      (await db.all("SELECT id, published_version FROM items WHERE library_id = ? ORDER BY id", library.id)) as unknown[];
    const before = await versions();

    await db.exec(await readFile(new URL("../migrations/025_single_review_date.sql", import.meta.url), "utf8"));

    assert.equal((await itemFreshness(db, unset))?.reviewBy, "2027-03-31", "stated date moved into review_by");
    assert.equal((await itemFreshness(db, confirmed))?.reviewBy, day(40), "an existing review_by wins");
    const row = (await db.get("SELECT details, published_snapshot FROM items WHERE id = ?", unset)) as { details: string; published_snapshot: string };
    assert.equal(JSON.parse(row.details).review_date, undefined);
    assert.equal(JSON.parse(JSON.parse(row.published_snapshot).details).review_date, undefined);
    assert.equal(JSON.parse(row.details).owner, "CISO");
    assert.deepEqual(await versions(), before, "not a new publish");
    const lib = await getLibrary(db, library.id);
    assert.ok(!lib?.schema.fields.some((field) => field.key === "review_date"));
  });
});
