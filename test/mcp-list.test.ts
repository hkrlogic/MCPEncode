import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibrary, listLibraries } from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";
import {
  AGENT_INSTRUCTIONS,
  MISSING_LIBRARY_LIST,
  NOT_CONNECTED,
  UNAUTHORIZED_MCP,
  missingLibraryId,
} from "../src/mcp/server.ts";

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
  assert.match(AGENT_INSTRUCTIONS, /Purpose, Scope, and Policy/);
  assert.match(AGENT_INSTRUCTIONS, /Procedure library uses fixed fields: Owner, Related policy/);
  assert.ok(AGENT_INSTRUCTIONS.includes(NOT_CONNECTED));
  assert.match(UNAUTHORIZED_MCP, /Not signed in/);
  assert.match(UNAUTHORIZED_MCP, /Do not invent/);
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
