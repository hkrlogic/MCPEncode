import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createLibrary, listLibraries } from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";
import {
  AGENT_INSTRUCTIONS,
  MISSING_LIBRARY_LIST,
  NOT_CONNECTED,
  UNAUTHORIZED_MCP,
  buildMcpServer,
  missingLibraryId,
} from "../src/mcp/server.ts";

function authFor(role: "edit" | "readonly"): AuthInfo {
  return {
    token: "test",
    clientId: "mpos-mcp",
    scopes: role === "edit" ? ["openid", "mpos:edit"] : ["openid", "mpos:readonly"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { sub: role === "edit" ? "mpos-editor" : "mpos-reader", role },
  };
}

function registeredToolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(tools).sort();
}

test("item list without library_id is rejected", () => {
  assert.equal(missingLibraryId(undefined), true);
  assert.equal(missingLibraryId(""), true);
  assert.equal(missingLibraryId("b1f48666-08a9-4fe8-ad56-28bd20697e75"), false);
  assert.equal(
    MISSING_LIBRARY_LIST,
    "Name a library (use list_libraries). I will not list every dataset.",
  );
});

test("agent instructions tell the model to cite, scope by library, and stop if disconnected", () => {
  assert.match(AGENT_INSTRUCTIONS, /Cite an item or say it is not in the library/);
  assert.match(AGENT_INSTRUCTIONS, /one call/);
  assert.match(AGENT_INSTRUCTIONS, /library_name and q/);
  assert.match(AGENT_INSTRUCTIONS, /A library name or library_id is required/);
  assert.match(AGENT_INSTRUCTIONS, /Do not say MCP unless they do/);
  assert.match(AGENT_INSTRUCTIONS, /Do not call whoami on every question/);
  assert.match(AGENT_INSTRUCTIONS, /create_library/);
  assert.match(AGENT_INSTRUCTIONS, /Purpose, Scope, and Policy/);
  assert.match(AGENT_INSTRUCTIONS, /Procedure library uses fixed fields: Owner, Related policy/);
  assert.match(AGENT_INSTRUCTIONS, /save drafts only/);
  assert.match(AGENT_INSTRUCTIONS, /do not invent a publish tool call/i);
  assert.ok(AGENT_INSTRUCTIONS.includes(NOT_CONNECTED));
  assert.match(UNAUTHORIZED_MCP, /Not signed in/);
  assert.match(UNAUTHORIZED_MCP, /Do not invent/);
});

test("create_library inserts with template", async () => {
  await withTestDatabase(async (db) => {
    const row = await createLibrary(db, "Access control policy", "editor", "policy");
    assert.equal(row.name, "Access control policy");
    assert.equal(row.template, "policy");
    const catalog = await listLibraries(db);
    assert.ok(catalog.some((lib) => lib.id === row.id && lib.template === "policy"));
  });
});

test("editor MCP tools include create and update but not publish", async () => {
  await withTestDatabase(async (db) => {
    const editorTools = registeredToolNames(buildMcpServer(db, authFor("edit")));
    assert.ok(editorTools.includes("create_library"));
    assert.ok(editorTools.includes("create_record"));
    assert.ok(editorTools.includes("update_record"));
    assert.equal(editorTools.includes("publish_record"), false);
    assert.equal(editorTools.includes("publish_item"), false);
    const readerTools = registeredToolNames(buildMcpServer(db, authFor("readonly")));
    assert.equal(readerTools.includes("create_library"), false);
    assert.equal(readerTools.includes("create_record"), false);
    assert.ok(readerTools.includes("list_libraries"));
  });
});

test("list_libraries catalog is id and name only", async () => {
  await withTestDatabase(async (db) => {
    await createLibrary(db, "Windows patching", "alice");
    const catalog = (await listLibraries(db)).map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
    }));
    assert.ok(catalog.every((row) => Object.keys(row).join(",") === "id,name,template"));
    assert.ok(catalog.some((row) => row.name === "Windows patching" && row.template === "general"));
  });
});
