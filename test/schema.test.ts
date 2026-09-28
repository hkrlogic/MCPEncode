import assert from "node:assert/strict";
import { test } from "node:test";
import { itemInputSchema, parseLabelField, excerptOf } from "../src/items/schema.ts";

test("parses comma-separated tags into a unique lowercase list", () => {
  assert.deepEqual(parseLabelField("Ops, poc, OPS"), ["ops", "poc"]);
});

test("rejects an empty name", () => {
  const result = itemInputSchema.safeParse({ name: "  ", body: "hi", labels: [] });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, "Name is required");
  }
});

test("accepts markdown notes", () => {
  const result = itemInputSchema.parse({
    name: "Runbook",
    body: "# Heading\n\n**bold**",
    labels: ["ops"],
  });
  assert.equal(result.body.includes("# Heading"), true);
});

test("excerpt flattens whitespace", () => {
  assert.equal(excerptOf("hello\n\nworld"), "hello world");
});

test("accepts a long Markdown description", () => {
  const body = `${"Policy text. ".repeat(80)}\n\n- Step one\n- Step two`;
  const result = itemInputSchema.parse({
    name: "Acceptable use",
    body: `Staff must follow this policy.\n\n${body}`,
    labels: ["policy"],
  });
  assert.ok(result.body.length > 300);
  assert.match(result.body, /Step two/);
});
