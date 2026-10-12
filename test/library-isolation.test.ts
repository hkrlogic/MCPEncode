import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createAccountGuard } from "../src/auth/account-guard.ts";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import {
  addDraftItem,
  createLibrary,
  deleteItem,
  getItem,
  getLibraryItem,
  grantLibraryAccess,
  listAudit,
  updateItem,
  writeAudit,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { buildMcpServer, resolveLibraryMcpAccess } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

function authFor(role: "sa" | "readonly", sub: string): AuthInfo {
  return {
    token: "test",
    clientId: "mpos-mcp",
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    extra: { sub, role },
  };
}

function tools(server: ReturnType<typeof buildMcpServer>): Record<string, Tool> {
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

async function call(server: ReturnType<typeof buildMcpServer>, name: string, args: unknown): Promise<ToolResult> {
  const tool = tools(server)[name];
  assert.ok(tool, `${name} is registered`);
  return tool.handler(args, {});
}

function text(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text).join("\n");
}

async function serverFor(db: Database, role: "sa" | "readonly", sub: string, libraryId: string) {
  const auth = authFor(role, sub);
  const scoped = await resolveLibraryMcpAccess(db, auth, libraryId);
  assert.ok(!("error" in scoped), JSON.stringify(scoped));
  return buildMcpServer(db, auth, scoped);
}

async function twoLibraries(db: Database) {
  const a = await createLibrary(db, "Library A", "sa-1", "general");
  const b = await createLibrary(db, "Library B", "sa-1", "general");
  const made = await addDraftItem(db, b.id, { name: "B secret", body: "TOP-SECRET-B" }, "sa-1");
  assert.ok(made.ok);
  await grantLibraryAccess(db, { libraryId: a.id, subject: "pub-a", role: "publisher", grantedBy: "sa-1" });
  await grantLibraryAccess(db, { libraryId: a.id, subject: "reader-a", role: "reader", grantedBy: "sa-1" });
  await grantLibraryAccess(db, { libraryId: b.id, subject: "pub-b", role: "publisher", grantedBy: "sa-1" });
  return { a, b, bItem: made.item };
}

test("a publisher on library A cannot open, update or delete an item in library B", async () => {
  await withTestDatabase(async (db) => {
    const { a, b, bItem } = await twoLibraries(db);
    const server = await serverFor(db, "readonly", "pub-a", a.id);

    const opened = await call(server, "open_item", { id: bItem.id });
    assert.equal(opened.isError, true);
    assert.doesNotMatch(text(opened), /TOP-SECRET-B/);

    const updated = await call(server, "update_item", { id: bItem.id, name: "pwned", body: "overwritten" });
    assert.equal(updated.isError, true);

    const after = await getItem(db, bItem.id, { publishedOnly: false });
    assert.equal(after?.name, "B secret");
    assert.equal(after?.body, "TOP-SECRET-B");
    assert.equal(after?.library_id, b.id);
  });
});

test("an SA on library A's link cannot open, update or delete library B's items", async () => {
  await withTestDatabase(async (db) => {
    const { a, bItem } = await twoLibraries(db);
    const server = await serverFor(db, "sa", "sa-1", a.id);

    assert.equal((await call(server, "open_item", { id: bItem.id })).isError, true);
    assert.equal(
      (await call(server, "update_item", { id: bItem.id, name: "pwned", body: "overwritten" })).isError,
      true,
    );
    assert.equal((await call(server, "delete_item", { id: bItem.id })).isError, true);

    const after = await getItem(db, bItem.id, { publishedOnly: false });
    assert.equal(after?.name, "B secret");
  });
});

test("the same tools still work on the link's own library", async () => {
  await withTestDatabase(async (db) => {
    const { b, bItem } = await twoLibraries(db);
    const server = await serverFor(db, "sa", "sa-1", b.id);
    assert.match(text(await call(server, "open_item", { id: bItem.id })), /TOP-SECRET-B/);
    const updated = await call(server, "update_item", { id: bItem.id, name: "B renamed", body: "new body" });
    assert.notEqual(updated.isError, true, text(updated));
    assert.equal((await call(server, "delete_item", { id: bItem.id })).isError, undefined);
    assert.equal(await getItem(db, bItem.id, { publishedOnly: false }), undefined);
  });
});

test("item reads and writes with a library scope never cross libraries", async () => {
  await withTestDatabase(async (db) => {
    const { a, b, bItem } = await twoLibraries(db);
    assert.equal(await getItem(db, bItem.id, { publishedOnly: false, libraryId: a.id }), undefined);
    assert.equal(await getLibraryItem(db, a.id, bItem.id, { publishedOnly: false }), undefined);
    assert.equal((await getLibraryItem(db, b.id, bItem.id, { publishedOnly: false }))?.id, bItem.id);
    await assert.rejects(getLibraryItem(db, "", bItem.id, { publishedOnly: false }));
    const moved = await updateItem(db, bItem.id, { name: "x", body: "y", labels: [] }, "sa-1", { libraryId: a.id });
    assert.equal(moved, undefined);
    assert.equal(await deleteItem(db, bItem.id, { libraryId: a.id }), false);
    assert.equal((await getItem(db, bItem.id, { publishedOnly: false }))?.name, "B secret");
  });
});

test("a reader on a library does not get list_audit", async () => {
  await withTestDatabase(async (db) => {
    const { a } = await twoLibraries(db);
    const server = await serverFor(db, "readonly", "reader-a", a.id);
    assert.equal(tools(server).list_audit, undefined);
  });
});

test("a publisher on library A sees only A's audit events", async () => {
  await withTestDatabase(async (db) => {
    const { a, b, bItem } = await twoLibraries(db);
    // Something happens in B over B's own link.
    const serverB = await serverFor(db, "readonly", "pub-b", b.id);
    await call(serverB, "open_item", { id: bItem.id });
    await writeAudit(db, { actorSub: "someone", tool: "ui.update", success: true, libraryId: b.id, detail: bItem.id });
    await writeAudit(db, { actorSub: "someone", tool: "ui.unscoped", success: true, detail: "no library" });
    // And something in A.
    const serverA = await serverFor(db, "readonly", "pub-a", a.id);
    await call(serverA, "list_items", {});

    const listed = text(await call(serverA, "list_audit", {}));
    const events = (JSON.parse(listed) as { events: { tool: string; detail: string; actor_sub: string }[] }).events;
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => !event.detail.includes(bItem.id)), listed);
    assert.ok(events.every((event) => event.actor_sub !== "pub-b" && event.actor_sub !== "someone"));
    assert.ok(events.some((event) => event.tool === "list_items" && event.actor_sub === "pub-a"));

    assert.ok((await listAudit(db, b.id)).some((event) => event.detail === bItem.id));
    await assert.rejects(listAudit(db, ""));
  });
});

test("an SA on library A's link sees only A's audit events too", async () => {
  await withTestDatabase(async (db) => {
    const { a, b, bItem } = await twoLibraries(db);
    await writeAudit(db, { actorSub: "pub-b", tool: "open_item", success: true, libraryId: b.id, detail: bItem.id });
    const server = await serverFor(db, "sa", "sa-1", a.id);
    const listed = text(await call(server, "list_audit", {}));
    assert.doesNotMatch(listed, new RegExp(bItem.id));
  });
});

test("a demoted SA with a still-valid SA token gets no write, delete or audit tools", async () => {
  await withTestDatabase(async (db) => {
    const { a, bItem } = await twoLibraries(db);
    const accounts = memoryAccountStore();
    const eve = await accounts.create({ username: "eve", password: "correct horse battery", role: "sa" });
    const keeper = await accounts.create({ username: "keeper", password: "correct horse battery", role: "sa" });
    assert.ok(eve.ok && keeper.ok);
    await grantLibraryAccess(db, { libraryId: a.id, subject: eve.account.id, role: "reader", grantedBy: "sa-1" });
    assert.ok((await accounts.setSa(eve.account.id, false)).ok);

    // The token still says SA. The guard says otherwise.
    const auth = authFor("sa", eve.account.id);
    const scoped = await resolveLibraryMcpAccess(db, auth, a.id, createAccountGuard(accounts));
    assert.ok(!("error" in scoped));
    assert.equal(scoped.idpRole, "readonly");
    const server = buildMcpServer(db, auth, scoped);
    const names = Object.keys(tools(server)).sort();
    for (const name of ["create_item", "update_item", "delete_item", "create_library", "propose_table", "propose_field", "list_audit"]) {
      assert.equal(names.includes(name), false, `${name} must not be registered`);
    }
    assert.ok(names.includes("list_items"));
    const whoami = JSON.parse(text(await call(server, "whoami", {}))) as { permissions: string[] };
    assert.deepEqual(whoami.permissions, ["records.read"]);
    // And no access to another library at all.
    assert.ok("error" in (await resolveLibraryMcpAccess(db, auth, bItem.library_id, createAccountGuard(accounts))));
  });
});

test("the audit migration backfills the library where the old detail names it", async () => {
  await withTestDatabase(async (db) => {
    const { a, b, bItem } = await twoLibraries(db);
    const insert = (id: string, tool: string, detail: string) =>
      db.run(
        "INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at) VALUES (?, 'x', ?, TRUE, ?, ?)",
        id,
        tool,
        detail,
        Date.now(),
      );
    await insert("00000000-0000-4000-8000-0000000000a1", "list_items", `browse library=${a.id} count=1`);
    await insert("00000000-0000-4000-8000-0000000000a2", "open_item", bItem.id);
    await insert("00000000-0000-4000-8000-0000000000a3", "propose_table", `${a.id}:Hosts`);
    await insert("00000000-0000-4000-8000-0000000000a4", "delete_item", crypto.randomUUID());
    const { readFile } = await import("node:fs/promises");
    await db.exec(await readFile(new URL("../migrations/013_audit_library.sql", import.meta.url), "utf8"));
    const rows = (await db.all(
      "SELECT id, library_id FROM audit_events WHERE id LIKE '00000000-0000-4000-8000-0000000000a%' ORDER BY id",
    )) as { id: string; library_id: string | null }[];
    assert.deepEqual(
      rows.map((row) => row.library_id),
      [a.id, b.id, a.id, null],
    );
  });
});
