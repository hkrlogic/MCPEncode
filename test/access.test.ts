import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDraftItem,
  createLibrary,
  getLibrary,
  grantLibraryAccess,
  listLibrariesForSubject,
  listOrphanLibraries,
  pendingCountsForPublisher,
  publishItem,
  publishedCountsForSubject,
  revokeLibraryAccess,
  rotateLibraryConnectToken,
} from "../src/db/queries.ts";
import { DEFAULT_LIBRARY_ID } from "../src/db/migrate.ts";
import { withTestDatabase } from "./db.ts";
import { connectTokensMatch, libraryMcpUrl, isLibraryId } from "../src/http/library-url.ts";

test("library MCP URL includes the connect token and id is validated", () => {
  const token = "test-connect-token-cccccccccccccccccc";
  assert.equal(
    libraryMcpUrl("http://127.0.0.1:3000", DEFAULT_LIBRARY_ID, token),
    `http://127.0.0.1:3000/libraries/${DEFAULT_LIBRARY_ID}/mcp/${token}`,
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

test("pending counts are visible only to publishers on that library", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Windows patching", "alice", "general");
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "carol",
      role: "reader",
      grantedBy: "alice",
    });
    const saved = await addDraftItem(
      db,
      library.id,
      { name: "Patch Tuesday", body: "Apply updates", labels: [] },
      "alice",
    );
    assert.equal(saved.ok, true);

    const alice = await pendingCountsForPublisher(db, "alice");
    assert.equal(alice.get(library.id), 1);
    const carol = await pendingCountsForPublisher(db, "carol");
    assert.equal(carol.has(library.id), false);

    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    await publishItem(db, saved.item.id, "alice");
    const published = await publishedCountsForSubject(db, "alice");
    assert.equal(published.get(library.id), 1);
    assert.equal((await pendingCountsForPublisher(db, "alice")).get(library.id) ?? 0, 0);
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

test("rotating the connect token kills the old URL and keeps access grants", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Shared runbooks", "alice", "general");
    assert.ok(library.connectToken.length >= 32);
    const before = library.connectToken;
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "bob",
      role: "reader",
      grantedBy: "alice",
    });

    const rotated = await rotateLibraryConnectToken(db, library.id, "alice");
    assert.ok(rotated);
    assert.notEqual(rotated.connectToken, before);
    assert.equal(connectTokensMatch(before, rotated.connectToken), false);

    const fresh = await getLibrary(db, library.id);
    assert.equal(fresh?.connectToken, rotated.connectToken);

    const subjects = await listLibrariesForSubject(db, "bob");
    assert.equal(subjects.some((row) => row.id === library.id), true);
  });
});

test("system Main library is an orphan until claimed", async () => {
  await withTestDatabase(async (db) => {
    const orphans = await listOrphanLibraries(db);
    assert.ok(orphans.some((row) => row.id === DEFAULT_LIBRARY_ID));
  });
});
