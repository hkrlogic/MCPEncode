import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibrary, createRecord, getRecord, listRecords } from "../src/db/queries.ts";
import { formatProcedure, itemForLibrary } from "../src/items/templates.ts";
import { withTestDatabase } from "./db.ts";

const escort = {
  owner: "Front Desk",
  related_policy: "Visitor escort",
  when_to_use: "A visitor arrives at the lobby.",
  steps: "1. Greet the visitor.\n2. Call the host.\n3. Stay with the visitor until they leave.",
  who: "Front Desk greets and calls the host. The host escorts.",
};

test("procedure text uses the fixed labels and no extra fields", () => {
  const text = formatProcedure(escort);
  assert.match(text, /^Template: Procedure\nOwner: Front Desk\nRelated policy: Visitor escort\n\nWhen to use it:\nA visitor arrives/);
  assert.match(text, /Steps:\n1\. Greet the visitor\./);
  assert.match(text, /Who does each step:\nFront Desk greets/);
  assert.doesNotMatch(text, /Template: Policy/);
  const rejected = itemForLibrary("procedure", { title: "Escort a visitor", notes: "free text" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /related_policy/);
});

test("a procedure library stores the steps, and a reader does not see the draft", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Lobby procedures", "alice", "procedure");
    assert.equal(library.template, "procedure");
    const saved = itemForLibrary("procedure", {
      title: "Escort a visitor",
      summary: "What to do when a visitor arrives.",
      tags: ["visitor"],
      ...escort,
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const created = await createRecord(db, saved.item, "alice", library.id);
    const opened = await getRecord(db, created.id, { publishedOnly: false });
    assert.equal(opened?.procedure?.related_policy, "Visitor escort");
    assert.match(opened?.procedure?.steps ?? "", /Call the host/);
    assert.equal(opened?.policy, undefined);
    const hidden = await listRecords(db, { library_id: library.id }, { publishedOnly: true });
    assert.equal(hidden.length, 0);
  });
});
