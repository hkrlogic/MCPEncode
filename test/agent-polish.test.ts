/** Agent-facing polish: one-round write errors, no-match is not an error, date order, short instructions, UTF-8. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createItem, createLibrary, getLibrary, publishItem } from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { declareUtf8, withUtf8 } from "../src/http/utf8-charset.ts";
import {
  mcpCreateItemInputSchema,
  mcpUpdateItemInputSchema,
  mcpWriteToolDescription,
  schemaForStarter,
} from "../src/items/library-schema.ts";
import { agentInstructions, buildMcpServer, readerKeyInstructions } from "../src/mcp/server.ts";
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

async function call(db: Database, libraryId: string, name: string, args: Record<string, unknown>) {
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
  // The SDK parses arguments with the tool's input schema first; do the same here.
  if (name === "create_item" || name === "update_item") {
    const schema =
      name === "create_item" ? mcpCreateItemInputSchema(library.schema) : mcpUpdateItemInputSchema(library.schema);
    const parsed = schema.safeParse(args);
    assert.ok(parsed.success, `tool schema let the call through: ${JSON.stringify(parsed.error?.issues)}`);
  }
  const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: (result.content ?? []).map((part) => part.text).join("\n") };
}

test("a bad create_item reports every problem in one answer, including non-string values", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "IT Policies", "pub-1", "policy");
    const result = await call(db, library.id, "create_item", {
      name: "Wifi",
      summary: "Guest wifi",
      owner: "",
      purpose: "",
      version: "v2",
      effective_date: "2026-13-01",
      scope: "x",
      policy: "x",
      colour: "blue",
      priority: 3,
      labels: ["ok", "x".repeat(41)],
      entity_key: "Bad Key!",
    });
    assert.equal(result.isError, true);
    for (const expected of [
      /Unsupported value for field\(s\): priority/,
      /Unknown field\(s\): colour/,
      /Owner is required/,
      /Purpose is required/,
      /Version must look like 1\.0/,
      /Effective date must be a real date/,
      /Entity key must start with a letter or digit/,
      /labels/,
    ]) {
      assert.match(result.text, expected);
    }
    // The field list is said once, at the end.
    assert.equal(result.text.split("This library uses the policy schema").length - 1, 1);
  });
});

test("update_item with a wrong type and a schema problem reports both", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const created = await call(db, library.id, "create_item", { name: "Printer", body: "Reset" });
    assert.equal(created.isError, false, created.text);
    const id = /^id: (\S+)$/m.exec(created.text)?.[1];
    assert.ok(id);
    const result = await call(db, library.id, "update_item", { id, name: "", summary: "nope", labels: "ops", flag: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /Unsupported value for field\(s\): flag/);
    assert.match(result.text, /summary is not a field in this library/);
    assert.match(result.text, /labels must be an array of strings/);
    assert.match(result.text, /Name is required/);
  });
});

test("a lookup with no match is a normal answer, not a tool error", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Notes", "pub-1", "general");
    const item = await createItem(db, { name: "Printer", body: "Reset the queue", labels: [] }, "pub-1", library.id);
    await publishItem(db, item.id, "pub-1");
    const none = await call(db, library.id, "list_items", { q: "zebrafish tunnel" });
    assert.equal(none.isError, false);
    assert.match(none.text, /No matching item in this library/);
    assert.match(none.text, /Do not invent/);
    const noKey = await call(db, library.id, "list_items", { entity_key: "host:nope" });
    assert.equal(noKey.isError, false);
    assert.match(noKey.text, /No item with that entity_key/);
  });
});

test("instructions are short and keep the safety rules", () => {
  const policy = schemaForStarter("policy");
  const reviewed = agentInstructions("IT Policies", policy, "reviewed");
  const direct = agentInstructions("Ops", schemaForStarter("general"), "direct");
  const reader = readerKeyInstructions("IT Policies", policy);
  assert.ok(reviewed.length < 3200, `reviewed instructions are ${reviewed.length} chars`);
  assert.ok(direct.length < 3500, `direct instructions are ${direct.length} chars`);
  assert.ok(reader.length < 1400, `reader instructions are ${reader.length} chars`);
  for (const text of [reviewed, direct, reader]) {
    assert.match(text, /Cite an item or say it is not in the library\. Do not invent\./);
    assert.match(text, /cite_as/);
  }
  assert.match(reviewed, /published items only/);
  assert.match(reviewed, /Review Lock/);
  assert.match(reviewed, /do not invent a publish tool call/);
  assert.match(direct, /Review Unlock/);
  assert.match(reader, /published items only/);
  for (const kind of ["create", "update"] as const) {
    assert.ok(mcpWriteToolDescription(policy, kind, "reviewed").length < 520);
  }
});

test("MCP responses declare UTF-8", async () => {
  assert.equal(withUtf8("text/event-stream"), "text/event-stream; charset=utf-8");
  assert.equal(withUtf8("application/json"), "application/json; charset=utf-8");
  assert.equal(withUtf8("application/json; charset=utf-8"), "application/json; charset=utf-8");
  assert.equal(withUtf8("text/html"), "text/html");
  const server = createServer((req, res) => {
    declareUtf8(res);
    if (req.url === "/head") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
    } else {
      res.setHeader("content-type", "application/json");
      res.writeHead(200);
    }
    res.end("—");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const sse = await fetch(`http://127.0.0.1:${port}/head`);
    assert.equal(sse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const json = await fetch(`http://127.0.0.1:${port}/set`);
    assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    server.close();
  }
});
