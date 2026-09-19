import assert from "node:assert/strict";
import { test } from "node:test";
import { itemInputSchema, parseTagField, excerptOf } from "../src/items/schema.ts";

test("parses comma-separated tags into a unique lowercase list", () => {
  assert.deepEqual(parseTagField("Ops, poc, OPS"), ["ops", "poc"]);
});

test("rejects an empty name", () => {
  const result = itemInputSchema.safeParse({ title: "  ", notes: "hi", tags: [] });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, "Name is required");
  }
});

test("accepts markdown notes", () => {
  const result = itemInputSchema.parse({
    title: "Runbook",
    notes: "# Heading\n\n**bold**",
    tags: ["ops"],
  });
  assert.equal(result.notes.includes("# Heading"), true);
});

test("excerpt flattens whitespace", () => {
  assert.equal(excerptOf("hello\n\nworld"), "hello world");
});

test("accepts a long Markdown description", () => {
  const body = `${"Policy text. ".repeat(80)}\n\n- Step one\n- Step two`;
  const result = itemInputSchema.parse({
    title: "Acceptable use",
    notes: `Staff must follow this policy.\n\n${body}`,
    tags: ["policy"],
  });
  assert.ok(result.notes.length > 300);
  assert.match(result.notes, /Step two/);
});
