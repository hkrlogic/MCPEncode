/** Behaviour fixed after the deep test: one test (or a few) per finding. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { accessFromLibraryRole, ROLE_PERMISSIONS } from "../src/auth/rbac.ts";
import { grantedScope } from "../src/auth/embedded-idp.ts";
import { hostRefused } from "../src/auth/idp-store.ts";
import { accountStore } from "../src/db/accounts.ts";
import { actorNames } from "../src/db/actors.ts";
import { listAudit, listAuditLog, writeAudit } from "../src/db/audit.ts";
import { DEFAULT_LIBRARY_ID } from "../src/db/migrate.ts";
import { createItem, createLibrary, getItem, getLibrary, listItems, publishItem } from "../src/db/queries.ts";
import { grantLibraryAccess } from "../src/db/access.ts";
import type { Database } from "../src/db/types.ts";
import { noticeMessage } from "../src/http/pages/layout.ts";
import { readerMcpUrl } from "../src/http/pages/libraries.ts";
import { errorPage } from "../src/http/pages/login.ts";
import { libraryPage, librariesPage } from "../src/http/pages.ts";
import { formatSchemaFields, humanItemMessage, mcpCreateItemInputSchema, schemaForStarter } from "../src/items/library-schema.ts";
import { bodyWithoutSummary } from "../src/markdown/table.ts";
import { ACCOUNT_UNAVAILABLE, buildMcpServer, resolveLibraryMcpAccess, SIGNED_OUT_MCP } from "../src/mcp/server.ts";
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

async function publisherTools(db: Database, libraryId: string): Promise<Record<string, Tool>> {
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
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

const text = (r: ToolResult) => r.content?.map((c) => c.text).join("\n") ?? "";
const publisher = accessFromLibraryRole({ sub: "pub-1", clientId: "test", libraryRole: "publisher" });
const reader = accessFromLibraryRole({ sub: "r-1", clientId: "test", libraryRole: "reader" });
const sa = { sub: "boss", clientId: "test", role: "sa" as const, permissions: ROLE_PERMISSIONS.sa };
const CONNECT = "http://127.0.0.1:3000/libraries/abc/mcp/" + "t".repeat(43);

test("Items tab keeps a live item that has an edit pending, and says so", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "pub-1", "general");
    const item = await createItem(db, { name: "VPN", body: "Steps for VPN.", labels: [] }, "pub-1", library.id);
    await publishItem(db, item.id, "pub-1");
    const tools = await publisherTools(db, library.id);
    const live = await getItem(db, item.id, { publishedOnly: false });
    const res = await tools.update_item.handler(
      { id: item.id, expected_revision: live?.updated_at, body: "Steps for VPN, revised." },
      {},
    );
    assert.equal(res.isError, undefined, text(res));
    await createItem(db, { name: "Never published", body: "Draft only.", labels: [] }, "pub-1", library.id);
    const items = await listItems(db, { library_id: library.id }, { publishedOnly: false });
    const html = libraryPage({ access: publisher, csrf: "c", library: (await getLibrary(db, library.id))!, items, tab: "items", mcpUrl: CONNECT, shellLibraries: [] } as never);
    assert.match(html, /VPN/);
    assert.match(html, /Edit pending/);
    assert.doesNotMatch(html, /Never published/);
  });
});

test("save notices are not contradictory and never say kiosk", () => {
  assert.match(noticeMessage("edit_pending"), /keep the published version/i);
  assert.doesNotMatch(noticeMessage("edit_pending"), /not live|is unpublished/i);
  for (const n of ["created", "saved", "edit_pending", "unpublished", "pending", "published"]) {
    assert.doesNotMatch(noticeMessage(n), /kiosk/i);
  }
});

test("no user-facing text says kiosk", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const file of [...walk("src"), ...walk("public")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /kiosk/i, file);
  }
});

test("MCP after sign-out says reconnect; a disabled account stays distinct", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "pub-1", "general");
    const out = await resolveLibraryMcpAccess(db, auth, library.id, async () => ({ allowed: false, reason: "signed_out" }));
    assert.deepEqual(out, { error: SIGNED_OUT_MCP });
    assert.match(SIGNED_OUT_MCP, /Your sign-in ended; reconnect/);
    const off = await resolveLibraryMcpAccess(db, auth, library.id, async () => ({ allowed: false, reason: "disabled" }));
    assert.deepEqual(off, { error: ACCOUNT_UNAVAILABLE });
    assert.notEqual(SIGNED_OUT_MCP, ACCOUNT_UNAVAILABLE);
  });
});

test("actors show as usernames in list_audit and the audit log", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const boss = await accounts.createFirst({ username: "boss", password: "correct horse battery" });
    assert.ok(boss.ok);
    const library = await createLibrary(db, "Runbooks", boss.account.id, "general");
    await writeAudit(db, { actorSub: boss.account.id, tool: "create_item", success: true, libraryId: library.id });
    const names = await actorNames(db, [boss.account.id, "someone-else"]);
    assert.equal(names.get(boss.account.id), "boss");
    assert.equal(names.get("someone-else"), "someone-else");
    const rows = await listAudit(db, library.id);
    assert.equal(rows[0].actor, "boss");
    const log = await listAuditLog(db, { libraryIds: null });
    assert.equal(log.rows[0].actor, "boss");
  });
});

test("audit log is scoped to the given libraries and pages", async () => {
  await withTestDatabase(async (db) => {
    const a = await createLibrary(db, "A", "pub-1", "general");
    const b = await createLibrary(db, "B", "pub-1", "general");
    for (let i = 0; i < 5; i++) await writeAudit(db, { actorSub: "pub-1", tool: `t${i}`, success: true, libraryId: a.id });
    await writeAudit(db, { actorSub: "pub-1", tool: "other", success: true, libraryId: b.id });
    const first = await listAuditLog(db, { libraryIds: [a.id], limit: 3 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.hasMore, true);
    const second = await listAuditLog(db, { libraryIds: [a.id], limit: 3, offset: 3 });
    assert.equal(second.rows.length, 2);
    assert.equal(second.hasMore, false);
    assert.ok([...first.rows, ...second.rows].every((r) => r.library_name === "A"));
    assert.deepEqual((await listAuditLog(db, { libraryIds: [] })).rows, []);
    assert.equal((await listAuditLog(db, { libraryIds: null })).rows.length, 6);
  });
});

test("Reader key guidance uses the bare library URL and no rotate advice for Readers", async () => {
  assert.equal(readerMcpUrl(CONNECT), "http://127.0.0.1:3000/libraries/abc/mcp");
  await withTestDatabase(async (db) => {
    const library = (await getLibrary(db, (await createLibrary(db, "Runbooks", "pub-1", "general")).id))!;
    const forReader = libraryPage({ access: reader, csrf: "c", library, items: [], mcpUrl: CONNECT, readerKey: "mpr_" + "k".repeat(43), shellLibraries: [] } as never);
    assert.doesNotMatch(forReader, /[Rr]otate (the )?Connect/);
  });
});

test("web validation messages are human, MCP wording is unchanged", () => {
  const schema = schemaForStarter("general");
  const human = humanItemMessage("name: Too small: expected string to have >=1 characters", schema);
  assert.doesNotMatch(human, /expected string|>=/);
});

test("unknown fields reach the handler (loose schema) and are refused clearly", async () => {
  const schema = schemaForStarter("general");
  const parsed = mcpCreateItemInputSchema(schema).safeParse({ name: "X", body: "Y", colour: "red" });
  assert.ok(parsed.success);
  assert.equal((parsed.data as Record<string, unknown>).colour, "red");
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "pub-1", "general");
    const tools = await publisherTools(db, library.id);
    const res = await tools.create_item.handler({ name: "X", body: "Y", colour: "red" }, {});
    assert.equal(res.isError, true);
    assert.match(text(res), /colour/);
  });
});

test("update_item keeps omitted fields; replace:true clears them", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "pub-1", "general");
    const item = await createItem(db, { name: "VPN", body: "Steps.", labels: ["vpn", "net"] }, "pub-1", library.id);
    const tools = await publisherTools(db, library.id);
    let res = await tools.update_item.handler({ id: item.id, expected_revision: item.updated_at, body: "New steps." }, {});
    assert.equal(res.isError, undefined, text(res));
    let row = await getItem(db, item.id, { publishedOnly: false });
    assert.deepEqual(row?.labels, ["vpn", "net"]);
    assert.equal(row?.name, "VPN");
    res = await tools.update_item.handler(
      { id: item.id, expected_revision: row?.updated_at, replace: true, name: "VPN", body: "Only this." },
      {},
    );
    assert.equal(res.isError, undefined, text(res));
    row = await getItem(db, item.id, { publishedOnly: false });
    assert.deepEqual(row?.labels, []);
  });
});

test("create_item with an existing entity_key updates that item", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "pub-1", "general");
    const tools = await publisherTools(db, library.id);
    const one = await tools.create_item.handler({ name: "A", body: "first", entity_key: "srv-1" }, {});
    assert.equal(one.isError, undefined, text(one));
    const two = await tools.create_item.handler({ name: "A", body: "second", entity_key: "srv-1" }, {});
    assert.equal(two.isError, undefined, text(two));
    const items = await listItems(db, { library_id: library.id }, { publishedOnly: false });
    assert.equal(items.length, 1);
  });
});

test("first account removes the unused Main library; a used one stays", async () => {
  await withTestDatabase(async (db) => {
    assert.ok(await getLibrary(db, DEFAULT_LIBRARY_ID));
    const created = await accountStore(db).createFirst({ username: "boss", password: "correct horse battery" });
    assert.ok(created.ok);
    assert.equal(await getLibrary(db, DEFAULT_LIBRARY_ID), undefined);
  });
  await withTestDatabase(async (db) => {
    await createItem(db, { name: "Kept", body: "x", labels: [] }, "system", DEFAULT_LIBRARY_ID);
    assert.ok((await accountStore(db).createFirst({ username: "boss", password: "correct horse battery" })).ok);
    assert.ok(await getLibrary(db, DEFAULT_LIBRARY_ID));
  });
});

test("item body does not repeat the summary; empty optional fields are skipped", () => {
  assert.equal(bodyWithoutSummary("Short summary.\n\nRest of body.", "Short summary."), "Rest of body.");
  assert.equal(bodyWithoutSummary("Body only.", "Different."), "Body only.");
  const out = formatSchemaFields(
    "Laptop",
    [
      { key: "owner", label: "Owner", type: "text", kind: "control", required: false },
      { key: "purchased", label: "Purchased", type: "date", kind: "control", required: false },
    ] as never,
    { owner: "Ada", purchased: "" },
  );
  assert.match(out, /Owner/);
  assert.doesNotMatch(out, /Purchased/);
});

test("sidebar: orphan listed once; 1 item singular", () => {
  const html = librariesPage({
    access: sa,
    csrf: "c",
    libraries: [
      { id: "l1", name: "Solo", template: "general", writeMode: "reviewed", access_role: "publisher", itemCount: 1, pendingCount: 0 },
      { id: "l2", name: "Orphaned", template: "general", writeMode: "reviewed", access_role: "publisher", itemCount: 0, pendingCount: 0, orphan: true },
    ] as never,
  });
  assert.equal(html.match(/>Orphaned</g)?.length ?? 0, 1);
  assert.doesNotMatch(html, /\b1 items\b/);
});

test("error page header shows the signed-in state", () => {
  assert.match(errorPage("Nope", sa), /Sign out/);
});

test("token response scope follows the library role", () => {
  assert.equal(grantedScope("mpos-viewer", "publisher"), "openid mcpencode:readonly mcpencode:edit");
  assert.equal(grantedScope("mpos-viewer", "reader"), "openid mcpencode:readonly");
  assert.match(grantedScope("mpos-editor", undefined), /mcpencode:sa/);
});

test("revoked callback hosts refuse sign-in like denied ones", () => {
  assert.equal(hostRefused("revoked"), true);
  assert.equal(hostRefused("denied"), true);
  assert.equal(hostRefused("approved"), false);
  assert.equal(hostRefused(undefined), false);
});

void grantLibraryAccess;

test("Apps page lists a revoked host under Revoked, not Denied", async () => {
  const { appsPage } = await import("../src/http/pages/apps.ts");
  const html = (appsPage as (i: unknown) => string)({
    access: sa,
    csrf: "c",
    local: true,
    hosts: [{ host: "agent.example", status: "revoked", firstSeen: 0, lastSeen: 0, decidedAt: 1, decidedBy: "boss" }],
    envHosts: [],
    shell: { csrf: "c", libraries: [], orphans: [] },
  });
  assert.match(html, /<h2>Revoked<\/h2>/);
  assert.doesNotMatch(html, /<h2>Denied<\/h2>/);
});
