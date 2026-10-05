import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLibrary,
  grantLibraryAccess,
  listLibrariesForSubject,
  listOrphanLibraries,
  revokeLibraryAccess,
} from "../src/db/queries.ts";
import { DEFAULT_LIBRARY_ID } from "../src/db/migrate.ts";
import { withTestDatabase } from "./db.ts";
import { libraryMcpUrl, isLibraryId } from "../src/http/library-url.ts";

test("library MCP URL is stable and id-validated", () => {
  assert.equal(
    libraryMcpUrl("http://127.0.0.1:3000", DEFAULT_LIBRARY_ID),
    `http://127.0.0.1:3000/libraries/${DEFAULT_LIBRARY_ID}/mcp`,
  );
  assert.equal(isLibraryId(DEFAULT_LIBRARY_ID), true);
  assert.equal(isLibraryId("not-a-uuid"), false);
});

test("creator is publisher; readers are scoped to granted libraries only", async () => {
  await withTestDatabase(async (db) => {
    const a = await createLibrary(db, "Windows patching", "alice", "general");
    const b = await createLibrary(db, "HR handbook", "bob", "general");
    await grantLibraryAccess(db, {
      libraryId: a.id,
      subject: "carol",
      role: "reader",
      grantedBy: "alice",
    });

    const carol = await listLibrariesForSubject(db, "carol");
    assert.equal(carol.length, 1);
    assert.equal(carol[0]?.id, a.id);
    assert.equal(carol[0]?.access_role, "reader");

    const bob = await listLibrariesForSubject(db, "bob");
    assert.ok(bob.some((row) => row.id === b.id && row.access_role === "publisher"));
    assert.equal(
      bob.some((row) => row.id === a.id),
      false,
    );
  });
});

test("cannot revoke the last publisher", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Solo", "alice", "general");
    await assert.rejects(
      () => revokeLibraryAccess(db, library.id, "alice"),
      /Keep at least one publisher/,
    );
  });
});

test("system Main library is an orphan until claimed", async () => {
  await withTestDatabase(async (db) => {
    const orphans = await listOrphanLibraries(db);
    assert.ok(orphans.some((row) => row.id === DEFAULT_LIBRARY_ID));
  });
});
