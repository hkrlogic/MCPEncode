import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { createLibrary, listLibraries } from "../src/db/queries.ts";
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
  assert.match(AGENT_INSTRUCTIONS, /list_libraries/);
  assert.match(AGENT_INSTRUCTIONS, /library_id is required/);
  assert.match(AGENT_INSTRUCTIONS, /Do not say MCP unless they do/);
  assert.match(AGENT_INSTRUCTIONS, /Do not call whoami on every question/);
  assert.ok(AGENT_INSTRUCTIONS.includes(NOT_CONNECTED));
  assert.match(UNAUTHORIZED_MCP, /Not signed in/);
  assert.match(UNAUTHORIZED_MCP, /Do not invent/);
});

test("list_libraries catalog is id and name only", async () => {
  resetDatabaseCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpos-"));
  const db = await openDatabase(path.join(dir, "test.db"));
  await createLibrary(db, "Windows patching", "alice");
  const catalog = (await listLibraries(db)).map((row) => ({ id: row.id, name: row.name }));
  assert.ok(catalog.every((row) => Object.keys(row).join(",") === "id,name"));
  assert.ok(catalog.some((row) => row.name === "Windows patching"));
  resetDatabaseCache();
});
