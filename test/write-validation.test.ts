/** MCP and form item writes: label normalization, refused values, version format, shared limits, all issues at once. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod/v4";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createItem, createLibrary, getItem, getLibrary, publishItem } from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import {
  FIELD_TYPE_MAX,
  fieldMax,
  humanItemMessage,
  itemForLibrarySchema,
  mcpCreateItemInputSchema,
  plainGeneralSummaryIssue,
  schemaForStarter,
  type LibrarySchema,
} from "../src/items/library-schema.ts";
import { normalizeLabels } from "../src/items/schema.ts";
import { asItemWrite, buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

const auth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "pub-1", role: "readonly" },
};

async function call(db: Database, libraryId: string, name: string, args: unknown) {
  const library = await getLibrary(db, libraryId);
  assert.ok(library);
  const server = buildMcpServer(db, auth, {
    libraryId: library.id,
    libraryName: library.name,
    libraryRole: "publisher",
    idpRole: "readonly",
    schema: library.schema,
    writeMode: library.writeMode,
  });
  const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: (result.content ?? []).map((part) => part.text).join("\n") };
}

const idOf = (text: string) => {
  const match = /^id: ([0-9a-f-]{36})$/m.exec(text);
  assert.ok(match, `id line in:\n${text}`);
  return match[1];
};

const policy = {
  name: "Patching",
  summary: "Monthly patching",
  owner: "Ops",
  version: "1.0",
  effective_date: "2026-01-01",
  purpose: "Keep hosts patched",
  scope: "All servers",
  policy: "Patch monthly",
  responsibilities: "Ops patches",
};

test("normalizeLabels trims, lowercases, dedupes and drops empties without truncating", () => {
  assert.deepEqual(normalizeLabels([" Ops", "ops", "POC ", "", "  "]), ["ops", "poc"]);
  assert.deepEqual(normalizeLabels(undefined), []);
  const long = "x".repeat(41);
  assert.deepEqual(normalizeLabels([long]), [long]);
});

test("item writes store labels normalized; over-long labels are refused, not cut", () => {
  const general = itemForLibrarySchema("general", { name: "A", body: "b", labels: ["Ops", " ops ", "Net"] });
  assert.ok(general.ok);
  assert.deepEqual(general.item.labels, ["ops", "net"]);
  const structured = itemForLibrarySchema("policy", { ...policy, labels: ["Security", "SECURITY"] });
  assert.ok(structured.ok);
  assert.deepEqual(structured.item.labels, ["security"]);
  const tooLong = itemForLibrarySchema("general", { name: "A", labels: ["y".repeat(41)] });
  assert.equal(tooLong.ok, false);
});

test("MCP create_item and update_item normalize labels", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const created = await call(db, library.id, "create_item", { name: "Printer", body: "Reset it", labels: ["Ops", "OPS", " Net "] });
    assert.equal(created.isError, false, created.text);
    const id = idOf(created.text);
    assert.deepEqual((await getItem(db, id, { publishedOnly: false }))?.labels, ["ops", "net"]);
    const updated = await call(db, library.id, "update_item", { id, labels: ["Printers", "printers"] });
    assert.equal(updated.isError, false, updated.text);
    assert.deepEqual((await getItem(db, id, { publishedOnly: false }))?.labels, ["printers"]);
  });
});

test("asItemWrite refuses non-string values instead of dropping them", () => {
  const good = asItemWrite({ name: "A", labels: ["x"], gone: null });
  assert.ok(good.ok);
  assert.deepEqual(good.write, { name: "A", labels: ["x"] });
  const bad = asItemWrite({ name: "A", priority: 3, flag: true, meta: { a: 1 }, mixed: ["a", 1] });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /priority, flag, meta, mixed/);
});

test("MCP writes with a number or object field are refused with the key name", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const created = await call(db, library.id, "create_item", { name: "Printer", body: "x", priority: 3 });
    assert.equal(created.isError, true);
    assert.match(created.text, /Unsupported value for field\(s\): priority/);
    const ok = await call(db, library.id, "create_item", { name: "Printer", body: "x" });
    const id = idOf(ok.text);
    const updated = await call(db, library.id, "update_item", { id, extra: { nested: true } });
    assert.equal(updated.isError, true);
    assert.match(updated.text, /Unsupported value for field\(s\): extra/);
  });
});

test("summary on a plain General library is refused, not dropped", async () => {
  const general = schemaForStarter("general");
  assert.match(plainGeneralSummaryIssue(general, { name: "A", summary: "My summary" }) ?? "", /summary is not a field in this library/);
  // Empty summary is the same as not sending it; structured libraries take a summary.
  assert.equal(plainGeneralSummaryIssue(general, { name: "A", summary: "" }), undefined);
  assert.equal(plainGeneralSummaryIssue(schemaForStarter("policy"), { name: "A", summary: "S" }), undefined);
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const created = await call(db, library.id, "create_item", { name: "Printer", body: "Reset it", summary: "Nope" });
    assert.equal(created.isError, true);
    assert.match(created.text, /derived from the body/);
    // A partial update of a stored plain General item still works (no stored summary is replayed).
    const ok = await call(db, library.id, "create_item", { name: "Printer", body: "Reset it" });
    const updated = await call(db, library.id, "update_item", { id: idOf(ok.text), labels: ["ops"] });
    assert.equal(updated.isError, false, updated.text);
  });
});

test("optional version fields must look like a version when given", () => {
  const schema: LibrarySchema = {
    starter: "general",
    custom: true,
    fields: [{ key: "release", label: "Release", type: "version", required: false, kind: "control" }],
  };
  const base = { name: "A", summary: "S" };
  assert.ok(itemForLibrarySchema(schema, { ...base }).ok);
  assert.ok(itemForLibrarySchema(schema, { ...base, release: "" }).ok);
  assert.ok(itemForLibrarySchema(schema, { ...base, release: " 2.1 " }).ok);
  const bad = itemForLibrarySchema(schema, { ...base, release: "latest" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /Release must look like 1\.0/);
});

test("tool schema advertises the same default max per type that the save check enforces", () => {
  const schema: LibrarySchema = {
    starter: "general",
    custom: true,
    fields: [
      { key: "host", label: "Host", type: "text", required: false, kind: "control" },
      { key: "notes", label: "Notes", type: "longtext", required: false, kind: "body" },
    ],
  };
  const tool = mcpCreateItemInputSchema(schema);
  for (const field of schema.fields) {
    const max = fieldMax(field);
    assert.equal(max, FIELD_TYPE_MAX[field.type]);
    const atMax = { name: "A", summary: "S", [field.key]: "a".repeat(max) };
    const over = { name: "A", summary: "S", [field.key]: "a".repeat(max + 1) };
    const json = z.toJSONSchema(tool) as { properties: Record<string, { type?: string; description?: string }> };
    assert.equal(json.properties[field.key]?.type, "string");
    assert.match(json.properties[field.key]?.description ?? "", new RegExp(`At most ${max} characters`));
    assert.equal(itemForLibrarySchema(schema, atMax).ok, true, `${field.key} at max passes save`);
    assert.equal(itemForLibrarySchema(schema, over).ok, false, `${field.key} over max fails save`);
  }
});

test("every validation problem is reported at once", () => {
  const result = itemForLibrarySchema(schemaForStarter("policy"), {
    ...policy,
    owner: "",
    version: "v2",
    effective_date: "2026-13-40",
    colour: "blue",
  });
  assert.equal(result.ok, false);
  const message = result.ok ? "" : result.message;
  assert.match(message, /Unknown field\(s\): colour/);
  assert.match(message, /Owner is required/);
  assert.match(message, /Version must look like 1\.0/);
  assert.match(message, /Effective date must be/);
  const human = humanItemMessage(message, schemaForStarter("policy"));
  assert.match(human, /no field called colour/);
  assert.match(human, /Owner is required/);
  assert.doesNotMatch(human, /Do not invent fields/);
});

test("review_date is no longer a Policy field (review_by is the only review date)", () => {
  const sent = itemForLibrarySchema("policy", { ...policy, review_date: "2027-01-01" });
  assert.equal(sent.ok, false);
  assert.match(sent.ok ? "" : sent.message, /Unknown field\(s\): review_date/);
});

test("migration 024 normalizes stored labels and published copies without a new publish", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const item = await createItem(db, { name: "Printer", body: "Reset", labels: ["ops"] }, "pub-1", library.id);
    await publishItem(db, item.id, "pub-1");
    const before = (await db.get("SELECT published_version, published_snapshot FROM items WHERE id = ?", item.id)) as {
      published_version: number;
      published_snapshot: string;
    };
    const snapshot = JSON.parse(before.published_snapshot);
    snapshot.labels = ["Ops", " ops", "NET", ""];
    await db.run(
      "UPDATE items SET labels = ?::jsonb, published_snapshot = ?, previous_published_snapshot = ? WHERE id = ?",
      JSON.stringify(["Ops", "ops ", "Net", ""]),
      JSON.stringify(snapshot),
      "not json",
      item.id,
    );
    const versionBefore = (
      (await db.get("SELECT published_version FROM items WHERE id = ?", item.id)) as { published_version: number }
    ).published_version;
    await db.exec(await readFile(new URL("../migrations/024_normalize_labels.sql", import.meta.url), "utf8"));
    const after = (await db.get(
      "SELECT labels, published_snapshot, previous_published_snapshot, published_version FROM items WHERE id = ?",
      item.id,
    )) as { labels: string | string[]; published_snapshot: string; previous_published_snapshot: string; published_version: number };
    const labels = typeof after.labels === "string" ? JSON.parse(after.labels) : after.labels;
    assert.deepEqual(labels, ["ops", "net"]);
    assert.deepEqual(JSON.parse(after.published_snapshot).labels, ["ops", "net"]);
    assert.equal(after.previous_published_snapshot, "not json");
    assert.equal(after.published_version, versionBefore);
  });
});
