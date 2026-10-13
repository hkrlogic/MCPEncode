/** Approving an optional field must not break the agent writes that worked before it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  approveFieldProposal,
  createItem,
  createLibrary,
  getItem,
  getLibrary,
  proposeField,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import {
  itemForLibrarySchema,
  mcpCreateItemInputSchema,
  mcpUpdateItemInputSchema,
  schemaForStarter,
} from "../src/items/library-schema.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult>; inputSchema?: unknown };

const auth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "pub-1", role: "readonly" },
};

async function publisherServer(db: Database, libraryId: string) {
  const library = await getLibrary(db, libraryId);
  assert.ok(library);
  return buildMcpServer(db, auth, {
    libraryId: library.id,
    libraryName: library.name,
    libraryRole: "publisher",
    idpRole: "readonly",
    schema: library.schema,
    writeMode: library.writeMode,
  });
}

function tools(server: ReturnType<typeof buildMcpServer>): Record<string, Tool> {
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

async function approvedReviewBy(db: Database) {
  const library = await createLibrary(db, "Runbooks", "pub-1", "general");
  const item = await createItem(
    db,
    { name: "VPN Troubleshooting", body: "Fixes for VPN problems, in order.", labels: ["vpn"] },
    "pub-1",
    library.id,
  );
  const proposed = await proposeField(db, library.id, { label: "Review by", type: "date" }, "pub-1");
  assert.equal(proposed.ok, true);
  const approved = await approveFieldProposal(db, library.id, "pub-1");
  assert.equal(approved.ok, true);
  const after = await getLibrary(db, library.id);
  assert.ok(after);
  return { library: after, item };
}

test("General library: approving a field keeps summary optional for create_item and update_item", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await approvedReviewBy(db);
    assert.ok(library.schema.fields.some((field) => field.key === "review_by"));
    // The exact call shape that failed during validation: id, name, body, no summary.
    const update = mcpUpdateItemInputSchema(library.schema).safeParse({
      id: item.id,
      name: "VPN Troubleshooting",
      body: "Use the TCP 443 fallback profile.",
    });
    assert.equal(update.success, true, JSON.stringify(update.error?.issues));
    const create = mcpCreateItemInputSchema(library.schema).safeParse({ name: "Printer Queue Reset", body: "Clear it." });
    assert.equal(create.success, true, JSON.stringify(create.error?.issues));
    // A summary is still accepted when sent.
    assert.equal(
      mcpUpdateItemInputSchema(library.schema).safeParse({ id: item.id, name: "x", summary: "One line" }).success,
      true,
    );
  });
});

test("General library: update_item without summary saves after a field approval and derives the summary", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await approvedReviewBy(db);
    const server = await publisherServer(db, library.id);
    const result = await tools(server).update_item.handler(
      { id: item.id, name: "VPN Troubleshooting", body: "Use the TCP 443 fallback profile when UDP is blocked." },
      {},
    );
    const text = (result.content ?? []).map((part) => part.text).join("\n");
    assert.notEqual(result.isError, true, text);
    const saved = await getItem(db, item.id, { publishedOnly: false });
    assert.match(saved?.body ?? "", /TCP 443 fallback/);
    assert.match(saved?.summary ?? "", /TCP 443 fallback/);

    // The new optional field is usable on the next request (tools are built per request).
    const withField = await tools(server).update_item.handler(
      { id: item.id, name: "VPN Troubleshooting", body: "Same steps.", review_by: "2027-01-31" },
      {},
    );
    assert.notEqual(withField.isError, true);
  });
});

test("itemForLibrarySchema: extended General derives summary from the body", async () => {
  await withTestDatabase(async (db) => {
    const { library } = await approvedReviewBy(db);
    const saved = itemForLibrarySchema(library.schema, { name: "Lockout", body: "Verify identity first." });
    assert.equal(saved.ok, true);
    if (saved.ok) assert.equal(saved.item.summary, "Verify identity first.");
  });
});

test("Policy library still requires a summary (unchanged)", () => {
  const schema = schemaForStarter("policy");
  const parsed = mcpCreateItemInputSchema(schema).safeParse({ name: "Password Standard" });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error?.issues.some((issue) => issue.path[0] === "summary"));
});
