/** A shelf searches published items across its libraries and does not grant Access. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createItem,
  createLibrary,
  createShelf,
  deleteShelf,
  getLibrary,
  grantLibraryAccess,
  publishItem,
  searchShelf,
  setLibraryShelf,
} from "../src/db/queries.ts";
import { withTestDatabase } from "./db.ts";

test("shelf search is one bond: published hits, readable libraries only", async () => {
  await withTestDatabase(async (db) => {
    const shelf = await createShelf(db, "Facilities", "alice");
    assert.equal(shelf.ok, true);
    if (!shelf.ok) return;

    const procedures = await createLibrary(db, "Lobby procedures", "alice");
    const policy = await createLibrary(db, "Acceptable use", "alice");
    const alone = await createLibrary(db, "Windows patching", "alice");
    await setLibraryShelf(db, procedures.id, shelf.shelf.id, "alice");
    await setLibraryShelf(db, policy.id, shelf.shelf.id, "alice");

    const visitor = await createItem(
      db,
      { name: "Escort a visitor", body: "Desk signs them in", labels: ["lobby"], summary: "How to escort a visitor" },
      "alice",
      procedures.id,
    );
    await publishItem(db, visitor.id, "alice");
    const draft = await createItem(
      db,
      { name: "Visitor draft", body: "Not live", labels: [], summary: "Visitor draft still pending" },
      "alice",
      procedures.id,
    );
    const badge = await createItem(
      db,
      { name: "Visitor badge policy", body: "Badges expire daily", labels: ["badge"], summary: "Visitor badge rules" },
      "alice",
      policy.id,
    );
    await publishItem(db, badge.id, "alice");
    const patch = await createItem(
      db,
      { name: "Visitor patch window", body: "Unrelated", labels: [], summary: "Visitor mention outside the shelf" },
      "alice",
      alone.id,
    );
    await publishItem(db, patch.id, "alice");

    await grantLibraryAccess(db, {
      libraryId: procedures.id,
      subject: "bob",
      role: "reader",
      grantedBy: "alice",
    });

    const bob = await searchShelf(db, shelf.shelf.id, "visitor", { subject: "bob", sa: false });
    assert.deepEqual(
      bob.map((hit) => hit.name),
      ["Escort a visitor"],
    );
    assert.equal(bob.some((hit) => hit.itemId === draft.id), false);
    assert.equal(bob.some((hit) => hit.libraryId === policy.id), false);
    assert.equal(bob[0]?.summary.includes("escort"), true);
    assert.equal("body" in (bob[0] ?? {}), false);

    const alice = await searchShelf(db, shelf.shelf.id, "visitor", { subject: "alice", sa: true });
    assert.deepEqual(
      alice.map((hit) => hit.name).sort(),
      ["Escort a visitor", "Visitor badge policy"],
    );

    await setLibraryShelf(db, policy.id, null, "alice");
    const after = await searchShelf(db, shelf.shelf.id, "badge", { subject: "alice", sa: true });
    assert.equal(after.length, 0);

    assert.equal(await deleteShelf(db, shelf.shelf.id), true);
    const left = await getLibrary(db, procedures.id);
    assert.equal(left?.shelfId ?? null, null);
  });
});
