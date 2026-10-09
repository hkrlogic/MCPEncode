import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, createLibrary, listItems, publishItem, updateItem } from "../src/db/queries.ts";
import { schemaForStarter } from "../src/items/library-schema.ts";
import { focusChange, itemReview } from "../src/items/review.ts";
import { withTestDatabase } from "./db.ts";

const general = schemaForStarter("general");

test("a pending item with no published copy is new", () => {
  const review = itemReview(
    { name: "Lobby", labels: [], summary: "Front desk", body: "Hours", details: null },
    null,
    general,
  );
  assert.deepEqual(review, { kind: "new" });
});

test("a short edit names the field and keeps the previous text", () => {
  const review = itemReview(
    { name: "VPN", labels: ["remote"], summary: "Travel laptops", body: "Use company VPN", details: null },
    {
      name: "VPN",
      labels: ["remote"],
      summary: "Company VPN",
      body: "Use company VPN",
      details: null,
    },
    general,
  );
  assert.equal(review.kind, "changed");
  if (review.kind !== "changed") return;
  assert.deepEqual(review.fields, [
    { label: "Summary", before: "Company VPN", after: "Travel laptops", long: false },
  ]);
});

test("a description edit is long text, and an unchanged unpublish stays quiet", () => {
  const edited = itemReview(
    { name: "VPN", labels: [], summary: "Company VPN", body: "Use the travel profile", details: null },
    {
      name: "VPN",
      labels: [],
      summary: "Company VPN",
      body: "Use company VPN",
      details: null,
    },
    general,
  );
  assert.equal(edited.kind, "changed");
  if (edited.kind === "changed") {
    assert.equal(edited.fields[0]?.label, "Description");
    assert.equal(edited.fields[0]?.long, true);
  }

  const held = itemReview(
    { name: "VPN", labels: [], summary: "Company VPN", body: "Use company VPN", details: null },
    {
      name: "VPN",
      labels: [],
      summary: "Company VPN",
      body: "Use company VPN",
      details: null,
    },
    general,
  );
  assert.deepEqual(held, { kind: "unchanged" });
});

test("a policy edit names the fact and skips the generated description", () => {
  const before = {
    owner: "Facilities",
    approved_by: "",
    version: "1.0",
    effective_date: "2026-01-01",
    review_date: "2027-01-01",
    purpose: "Keep the lobby staffed.",
    scope: "Front desk",
    policy: "Someone is at the desk during open hours.",
    responsibilities: "",
    exceptions: "",
    references: "",
  };
  const after = { ...before, owner: "Security" };
  const review = itemReview(
    {
      name: "Lobby",
      labels: [],
      summary: "Front desk coverage",
      body: "generated after",
      details: JSON.stringify(after),
    },
    {
      name: "Lobby",
      labels: [],
      summary: "Front desk coverage",
      body: "generated before",
      details: JSON.stringify(before),
    },
    schemaForStarter("policy"),
  );
  assert.equal(review.kind, "changed");
  if (review.kind !== "changed") return;
  assert.deepEqual(
    review.fields.map((field) => field.label),
    ["Owner"],
  );
  assert.equal(review.fields[0]?.before, "Facilities");
  assert.equal(review.fields[0]?.after, "Security");
  assert.equal(review.fields[0]?.long, false);
});

test("a small edit inside a long description stays in view", () => {
  const before = `${"a".repeat(500)} Monday ${"b".repeat(500)}`;
  const after = `${"a".repeat(500)} Tuesday ${"b".repeat(500)}`;
  const focused = focusChange(before, after);
  assert.equal(focused.trimmed, true);
  assert.match(focused.before, /Monday/);
  assert.match(focused.after, /Tuesday/);
  assert.ok(focused.before.length < before.length);
});

test("publisher lists attach a review only when asked", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Access", "alice");
    const created = await createItem(
      db,
      { name: "VPN", body: "Use company VPN", labels: ["remote"], summary: "Company VPN" },
      "alice",
      library.id,
    );
    await publishItem(db, created.id, "alice");
    await updateItem(
      db,
      created.id,
      { name: "VPN", body: "Use company VPN", labels: ["remote"], summary: "Travel laptops" },
      "alice",
    );

    const catalog = await listItems(db, { library_id: library.id }, { publishedOnly: false });
    assert.equal(catalog[0]?.review, undefined);

    const pending = await listItems(
      db,
      { library_id: library.id },
      { publishedOnly: false },
      { review: library.schema },
    );
    assert.equal(pending[0]?.status, "draft");
    assert.equal(pending[0]?.review?.kind, "changed");
    if (pending[0]?.review?.kind === "changed") {
      assert.equal(pending[0].review.fields[0]?.label, "Summary");
      assert.equal(pending[0].review.fields[0]?.before, "Company VPN");
      assert.equal(pending[0].review.fields[0]?.after, "Travel laptops");
    }
  });
});
