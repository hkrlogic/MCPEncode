import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createLibrary, grantLibraryAccess } from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";
import {
  FORBIDDEN_LIBRARY,
  NOT_CONNECTED,
  UNAUTHORIZED_MCP,
  agentInstructions,
  buildMcpServer,
  resolveLibraryMcpAccess,
} from "../src/mcp/server.ts";

function authFor(role: "edit" | "readonly", sub?: string): AuthInfo {
  return {
    token: "test",
    clientId: "mpos-mcp",
    scopes: role === "edit" ? ["openid", "mpos:edit"] : ["openid", "mpos:readonly"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: {
      sub: sub ?? (role === "edit" ? "mpos-editor" : "mpos-reader"),
      role,
    },
  };
}

function registeredToolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(tools).sort();
}

test("agent instructions are scoped to one library and use list_items / open_item", () => {
  const text = agentInstructions("Windows patching");
  assert.match(text, /Windows patching/);
  assert.match(text, /list_items with q/);
  assert.match(text, /Call open_item only when list_items returns several matches/);
  assert.match(text, /do not ask for a library name or library_id/i);
  assert.match(text, /Do not say MCP unless they do/);
  assert.match(text, /save drafts only/);
  assert.ok(text.includes(NOT_CONNECTED));
  assert.match(UNAUTHORIZED_MCP, /Not signed in/);
  assert.match(FORBIDDEN_LIBRARY, /cannot open this library/);
});

test("publisher MCP tools include create and update but not publish", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Ops", "mpos-editor", "general");
    const ctx = {
      libraryId: library.id,
      libraryName: library.name,
      libraryRole: "publisher" as const,
    };
    const editorTools = registeredToolNames(buildMcpServer(db, authFor("edit"), ctx));
    assert.ok(editorTools.includes("list_items"));
    assert.ok(editorTools.includes("open_item"));
    assert.ok(editorTools.includes("create_item"));
    assert.ok(editorTools.includes("update_item"));
    assert.equal(editorTools.includes("list_libraries"), false);
    assert.equal(editorTools.includes("list_records"), false);
    assert.equal(editorTools.includes("get_record"), false);
    assert.equal(editorTools.includes("create_library"), false);
    assert.equal(editorTools.includes("publish_item"), false);
    const readerCtx = { ...ctx, libraryRole: "reader" as const };
    const readerTools = registeredToolNames(buildMcpServer(db, authFor("readonly"), readerCtx));
    assert.ok(readerTools.includes("list_items"));
    assert.equal(readerTools.includes("create_item"), false);
  });
});

test("MCP access requires a library access-list row for the subject", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "HR", "alice", "general");
    const denied = await resolveLibraryMcpAccess(db, authFor("edit", "mpos-editor"), library.id);
    assert.deepEqual(denied, { error: FORBIDDEN_LIBRARY });

    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "mpos-editor",
      role: "reader",
      grantedBy: "alice",
    });
    const allowed = await resolveLibraryMcpAccess(db, authFor("edit", "mpos-editor"), library.id);
    assert.deepEqual(allowed, {
      libraryId: library.id,
      libraryName: "HR",
      libraryRole: "reader",
    });
  });
});

test("create_library grants the creator as publisher", async () => {
  await withTestDatabase(async (db) => {
    const row = await createLibrary(db, "Access control policy", "editor", "policy");
    assert.equal(row.template, "policy");
    const scoped = await resolveLibraryMcpAccess(db, authFor("edit", "editor"), row.id);
    assert.deepEqual(scoped, {
      libraryId: row.id,
      libraryName: row.name,
      libraryRole: "publisher",
    });
  });
});
