import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibrary, createItem, getLibrary } from "../src/db/queries.ts";
import {
  itemForLibrarySchema,
  mcpCreateItemInputSchema,
  mcpItemWriteKeys,
  mcpWriteToolDescription,
  schemaForStarter,
} from "../src/items/library-schema.ts";
import { itemForLibrary } from "../src/items/templates.ts";
import { withTestDatabase } from "./db.ts";

test("starter copy is stored on create and differs by library", async () => {
  await withTestDatabase(async (db) => {
    const policy = await createLibrary(db, "Policies", "alice", "policy");
    const general = await createLibrary(db, "Notes", "alice", "general");
    assert.equal(policy.schema.starter, "policy");
    assert.equal(general.schema.starter, "general");
    assert.ok(policy.schema.fields.some((field) => field.key === "purpose"));
    assert.equal(
      general.schema.fields.some((field) => field.key === "purpose"),
      false,
    );
    const reloaded = await getLibrary(db, policy.id);
    assert.deepEqual(reloaded?.schema, schemaForStarter("policy"));
  });
});

test("item writes enforce the library schema and reject foreign fields", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "alice", "procedure");
    const bad = itemForLibrary(library.schema, {
      name: "Patch Tuesday",
      summary: "Monthly rings",
      owner: "Ops",
      related_policy: "Patching",
      when_to_use: "Second Tuesday",
      steps: "1. Ring\n2. Verify",
      who: "On-call",
      purpose: "not a procedure field",
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /Unknown field\(s\): purpose/);

    const good = itemForLibrarySchema(library.schema, {
      name: "Patch Tuesday",
      summary: "Monthly rings",
      owner: "Ops",
      related_policy: "Patching",
      when_to_use: "Second Tuesday",
      steps: "1. Ring\n2. Verify",
      who: "On-call",
    });
    assert.equal(good.ok, true);
    if (!good.ok) return;
    const created = await createItem(db, good.item, "alice", library.id);
    assert.match(created.body, /Template: Procedure/);
    assert.equal(created.procedure?.steps, "1. Ring\n2. Verify");
  });
});

test("policy schema rejects a general body and accepts closed fields", () => {
  const schema = schemaForStarter("policy");
  const rejected = itemForLibrarySchema(schema, {
    name: "Remote access",
    summary: "Guests",
    body: "free text",
    owner: "Office Lead",
    version: "1.0",
    effective_date: "2026-09-01",
    review_date: "2027-09-01",
    purpose: "Limit guests",
    scope: "Office",
    policy: "Use the gateway",
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /Unknown field\(s\): body/);

  const ok = itemForLibrarySchema(schema, {
    name: "Remote access",
    summary: "Guests",
    owner: "Office Lead",
    version: "1.0",
    effective_date: "2026-09-01",
    review_date: "2027-09-01",
    purpose: "Limit guests",
    scope: "Office",
    policy: "Use the gateway",
  });
  assert.equal(ok.ok, true);
});

test("MCP create_item tool schema is per-library (dynamic)", () => {
  const general = mcpItemWriteKeys(schemaForStarter("general"));
  const policy = mcpItemWriteKeys(schemaForStarter("policy"));
  const procedure = mcpItemWriteKeys(schemaForStarter("procedure"));

  assert.deepEqual(general, ["body", "labels", "name"]);
  assert.ok(policy.includes("purpose"));
  assert.ok(policy.includes("policy"));
  assert.equal(policy.includes("steps"), false);
  assert.equal(policy.includes("body"), false);
  assert.ok(procedure.includes("steps"));
  assert.equal(procedure.includes("purpose"), false);

  const policyTool = mcpCreateItemInputSchema(schemaForStarter("policy"));
  const bad = policyTool.safeParse({ name: "X", summary: "Y", steps: "1. no" });
  assert.equal(bad.success, false);

  const desc = mcpWriteToolDescription(schemaForStarter("procedure"), "create");
  assert.match(desc, /procedure schema/);
  assert.match(desc, /steps/);
  assert.doesNotMatch(desc, /\bpurpose\b/);
});
