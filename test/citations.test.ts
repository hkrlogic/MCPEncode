/** Citation block: version, dates, publisher and link for the published copy. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { citationsFor } from "../src/db/citations.ts";
import {
  createItem,
  createLibrary,
  createShelf,
  getLibrary,
  publishItem,
  setLibraryShelf,
  setLibraryWriteMode,
  updateItem,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

type ToolResult = { content?: { type: string; text: string }[]; isError?: boolean };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

const BASE = "https://library.example.org";
const DANA = "151ecd6c-77bd-4998-b7af-58c0447904c8";

const auth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: DANA, role: "readonly" },
};

async function addAccount(db: Database) {
  await db.run(
    "INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    DANA,
    "dana.publisher",
    "not-a-hash",
    "readonly",
    Date.now(),
  );
}

async function server(db: Database, libraryId: string, role: "reader" | "publisher") {
  const library = await getLibrary(db, libraryId);
  assert.ok(library);
  return buildMcpServer(
    db,
    auth,
    {
      libraryId: library.id,
      libraryName: library.name,
      libraryRole: role,
      idpRole: "readonly",
      schema: library.schema,
      writeMode: library.writeMode,
      shelfId: library.shelfId ?? null,
      shelfName: library.shelfName ?? null,
      ...(role === "reader" ? { readerKey: true } : {}),
    },
    { publicBaseUrl: BASE },
  );
}

async function call(s: ReturnType<typeof buildMcpServer>, name: string, args: unknown): Promise<string> {
  const tool = (s as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return (result.content ?? []).map((part) => part.text).join("\n");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function vpnRunbook(db: Database) {
  await addAccount(db);
  const library = await createLibrary(db, "Help Desk Runbooks", DANA);
  const item = await createItem(
    db,
    { name: "VPN Troubleshooting", body: "Switch to the TCP fallback profile.", labels: ["vpn"] },
    DANA,
    library.id,
  );
  await publishItem(db, item.id, DANA);
  return { library, item };
}

test("Reader open_item ends with one cite_as line carrying version, date, publisher and URL", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await vpnRunbook(db);
    const text = await call(await server(db, library.id, "reader"), "open_item", { id: item.id });
    const lines = text.split("\n");
    const citeAs = lines.find((line) => line.startsWith("cite_as: "));
    assert.ok(citeAs, "cite_as line");
    assert.match(
      citeAs,
      /^cite_as: "VPN Troubleshooting" \(Help Desk Runbooks\), version 1, published \d{4}-\d{2}-\d{2} by dana\.publisher\. /,
    );
    assert.ok(citeAs.endsWith(` ${BASE}/items/${item.id} [item ${item.id} v1]`), citeAs);
    // The separate fields cite_as already carries are not repeated.
    for (const dropped of ["citation:", "  version:", "  published_at:", "  updated_at:", "  published_by:", "  url:", "stale:"]) {
      assert.ok(!lines.some((line) => line.startsWith(dropped)), `no ${dropped} line`);
    }
    assert.doesNotMatch(text, /^review_by:/m, "no review_by line when the library does not track it");
  });
});

test("version counts publishes; a Pending edit keeps citing the published version", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await vpnRunbook(db);
    await tick();
    await updateItem(db, item.id, { name: "VPN Troubleshooting", body: "Use the TCP 443 fallback.", labels: ["vpn"] }, DANA);
    const reader = await server(db, library.id, "reader");
    const pending = await call(reader, "open_item", { id: item.id });
    assert.match(pending, /TCP fallback profile/);
    assert.match(pending, /^cite_as: .*, version 1, /m, "Readers still cite v1 while the edit is Pending");

    await tick();
    await publishItem(db, item.id, DANA);
    const published = await call(reader, "open_item", { id: item.id });
    assert.match(published, /TCP 443 fallback/);
    assert.match(published, /^cite_as: .*, version 2, /m);
  });
});

test("never-published drafts say not to cite; list and lookup results carry citations", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await vpnRunbook(db);
    const draft = await createItem(db, { name: "VPN Draft Notes", body: "Not reviewed.", labels: ["vpn"] }, DANA, library.id);
    const publisher = await server(db, library.id, "publisher");
    const draftText = await call(publisher, "open_item", { id: draft.id, version: "draft" });
    assert.match(draftText, /citation: none — this item is not published; do not cite it/);

    const browse = JSON.parse(await call(publisher, "list_items", {})) as {
      items: { id: string; citation: { cite_as: string } | null }[];
    };
    const byId = new Map(browse.items.map((row) => [row.id, row.citation]));
    assert.match(byId.get(item.id)?.cite_as ?? "", /, version 1, /);
    assert.deepEqual(Object.keys(byId.get(item.id) ?? {}), ["cite_as"], "only cite_as when there is no review date or warning");
    assert.equal(byId.get(draft.id), null);

    const lookup = await call(await server(db, library.id, "reader"), "list_items", { q: "vpn" });
    assert.match(lookup, /cite_as: "VPN Troubleshooting"/);
  });
});

test("search_shelf hits carry the citation of the published copy", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await vpnRunbook(db);
    const shelf = await createShelf(db, "Support Desk", DANA);
    assert.equal(shelf.ok, true);
    if (!shelf.ok) return;
    await setLibraryShelf(db, library.id, shelf.shelf.id, DANA);
    const reader = await server(db, library.id, "reader");
    const result = JSON.parse(await call(reader, "search_shelf", { q: "VPN" })) as {
      hits: { item_id: string; citation: { cite_as: string } }[];
    };
    assert.equal(result.hits[0]?.item_id, item.id);
    assert.match(result.hits[0]?.citation.cite_as ?? "", /, version 1, /);
    assert.ok(result.hits[0]?.citation.cite_as.includes(`${BASE}/items/${item.id}`));
  });
});

test("Review Unlock: each live save is a new version", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await vpnRunbook(db);
    await setLibraryWriteMode(db, library.id, "direct", DANA);
    await tick();
    await updateItem(db, item.id, { name: "VPN Troubleshooting", body: "Live edit.", labels: [] }, DANA);
    const citations = await citationsFor(db, [item.id], BASE);
    assert.equal(citations.get(item.id)?.version, 2);
  });
});
