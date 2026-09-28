import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibrary, createItem, getItem, listItems } from "../src/db/queries.ts";
import { formatPolicy, itemForLibrary, parsePolicyDetails } from "../src/items/templates.ts";
import { withTestDatabase } from "./db.ts";

const remoteAccess = {
  owner: "Office Lead",
  approved_by: "Security",
  version: "1.0",
  effective_date: "2026-09-01",
  review_date: "2027-09-01",
  purpose: "Keep guest access on the company network limited.",
  scope: "Guests and the office network.",
  policy: "Guests use the gateway. No personal devices.",
  responsibilities: "Office Lead reviews guest requests.",
  exceptions: "",
  references: "",
};

test("policy text uses the fixed labels and no extra fields", () => {
  const text = formatPolicy(remoteAccess);
  assert.match(text, /^Template: Policy\n/);
  assert.match(text, /Owner: Office Lead\nApproved by: Security\nVersion: 1\.0\nEffective date: 2026-09-01\nReview date: 2027-09-01/);
  assert.match(text, /Purpose:\nKeep guest access/);
  assert.match(text, /Scope:\nGuests and the office network\./);
  assert.match(text, /Policy:\nGuests use the gateway/);
  assert.match(text, /Exceptions:\n\nReferences:$/);
  assert.doesNotMatch(text, /Rule:/);
  const rejected = itemForLibrary("policy", { name: "Remote access", body: "free text" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /purpose/);
  const earlyReview = itemForLibrary("policy", { ...remoteAccess, name: "Remote access", summary: "Guest network.", review_date: "2026-01-01" });
  assert.equal(earlyReview.ok, false);
});

test("an older policy that stored rule still opens as the policy statement", () => {
  const details = parsePolicyDetails(
    JSON.stringify({ owner: "Office Lead", effective_date: "2026-09-01", rule: "Guests use the gateway." }),
  );
  assert.equal(details?.policy, "Guests use the gateway.");
  assert.equal(details?.purpose, "");
});

test("a policy library stores the document fields, and a reader does not see the draft", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Approved policies", "alice", "policy");
    assert.equal(library.template, "policy");
    const saved = itemForLibrary("policy", {
      name: "Remote access",
      summary: "How guests reach the office network.",
      labels: ["remote"],
      ...remoteAccess,
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const created = await createItem(db, saved.item, "alice", library.id);
    const opened = await getItem(db, created.id, { publishedOnly: false });
    assert.equal(opened?.policy?.owner, "Office Lead");
    assert.equal(opened?.policy?.version, "1.0");
    assert.equal(opened?.policy?.review_date, "2027-09-01");
    assert.equal(opened?.policy?.purpose, remoteAccess.purpose);
    assert.match(opened?.body ?? "", /Template: Policy/);
    assert.equal(opened?.summary, "How guests reach the office network.");
    const hidden = await listItems(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(hidden.length, 0);
  });
});
