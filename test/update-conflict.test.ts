/** Optimistic concurrency: update_item / the edit form can refuse a save based on a stale copy. */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import {
  ItemConflictError,
  createItem,
  createLibrary,
  getItem,
  getLibrary,
  publishItem,
  updateItem,
} from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { mcpUpdateItemInputSchema } from "../src/items/library-schema.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function call(db: Database, libraryId: string, name: string, args: unknown) {
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
  const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { isError: result.isError === true, text: (result.content ?? []).map((part) => part.text).join("\n") };
}

function revisionOf(text: string): number {
  const match = /^revision: (\d+)$/m.exec(text);
  assert.ok(match, `revision line in:\n${text}`);
  return Number(match[1]);
}

async function printerItem(db: Database) {
  const library = await createLibrary(db, "Help Desk", "pub-1");
  const item = await createItem(db, { name: "Printer Queue Reset", body: "Clear a stuck queue.", labels: [] }, "pub-1", library.id);
  await publishItem(db, item.id, "pub-1");
  return { library, item };
}

test("updateItem: stale expectedRevision throws and saves nothing; current or omitted saves", async () => {
  await withTestDatabase(async (db) => {
    const { item } = await printerItem(db);
    const read = await getItem(db, item.id, { publishedOnly: false });
    assert.ok(read);
    await tick();
    await updateItem(db, item.id, { name: "Printer Queue Reset", body: "EDIT A", labels: [] }, "pub-1");
    await tick();
    await assert.rejects(
      updateItem(db, item.id, { name: "Printer Queue Reset", body: "EDIT B (stale)", labels: [] }, "pub-1", {
        expectedRevision: read.updated_at,
      }),
      (error: unknown) => error instanceof ItemConflictError && /changed since you read it/.test(error.message),
    );
    const afterConflict = await getItem(db, item.id, { publishedOnly: false });
    assert.equal(afterConflict?.body, "EDIT A");

    await tick();
    const current = await updateItem(db, item.id, { name: "Printer Queue Reset", body: "EDIT C", labels: [] }, "pub-1", {
      expectedRevision: afterConflict?.updated_at,
    });
    assert.equal(current?.body, "EDIT C");
    // Backward compatible: no revision means last write wins, as before.
    await tick();
    const legacy = await updateItem(db, item.id, { name: "Printer Queue Reset", body: "EDIT D", labels: [] }, "pub-1");
    assert.equal(legacy?.body, "EDIT D");
  });
});

test("updateItem: two parallel saves from the same revision, exactly one wins", async () => {
  await withTestDatabase(async (db) => {
    const { item } = await printerItem(db);
    const read = await getItem(db, item.id, { publishedOnly: false });
    assert.ok(read);
    await tick();
    const results = await Promise.allSettled(
      ["EDIT A", "EDIT B"].map((body) =>
        updateItem(db, item.id, { name: "Printer Queue Reset", body, labels: [] }, "pub-1", {
          expectedRevision: read.updated_at,
        }),
      ),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    assert.equal(won.length, 1, JSON.stringify(results.map((result) => result.status)));
    assert.equal(lost.length, 1);
    assert.ok((lost[0] as PromiseRejectedResult).reason instanceof ItemConflictError);
  });
});

test("MCP: open_item shows revision; update_item with a stale expected_revision returns a conflict", async () => {
  await withTestDatabase(async (db) => {
    const { library, item } = await printerItem(db);
    const opened = await call(db, library.id, "open_item", { id: item.id });
    const revision = revisionOf(opened.text);

    await tick();
    const first = await call(db, library.id, "update_item", {
      id: item.id,
      name: "Printer Queue Reset",
      body: "Agent A: check the printer is online first.",
      expected_revision: revision,
    });
    assert.equal(first.isError, false, first.text);
    const newRevision = revisionOf(first.text);
    assert.ok(newRevision > revision);

    // The published view of an item with a Pending edit reports the working revision.
    const live = await call(db, library.id, "open_item", { id: item.id });
    assert.match(live.text, /has_pending_changes: true/);
    assert.equal(revisionOf(live.text), newRevision);

    const stale = await call(db, library.id, "update_item", {
      id: item.id,
      name: "Printer Queue Reset",
      body: "Agent B: use Print Management instead.",
      expected_revision: revision,
    });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Conflict: this item changed since you read it/);
    assert.match(stale.text, new RegExp(`current_revision: ${newRevision}`));
    const draft = await getItem(db, item.id, { publishedOnly: false });
    assert.match(draft?.body ?? "", /Agent A/);

    // Omitting expected_revision keeps the old behavior.
    const legacy = await call(db, library.id, "update_item", { id: item.id, name: "Printer Queue Reset", body: "Agent B again" });
    assert.equal(legacy.isError, false);
  });
});

test("MCP schema: expected_revision is optional on update_item", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Any", "pub-1");
    const schema = mcpUpdateItemInputSchema(library.schema);
    const id = "3c0fcf77-7f80-4c63-bc03-1d4b2fd504e8";
    assert.equal(schema.safeParse({ id, name: "x" }).success, true);
    assert.equal(schema.safeParse({ id, name: "x", expected_revision: 1791922634872 }).success, true);
    assert.equal(schema.safeParse({ id, name: "x", expected_revision: "soon" }).success, false);
  });
});

const SESSION_SECRET = "test-session-secret-32-bytes-minimum!!";

function testConfig(port: number): AppConfig {
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    bindHost: "127.0.0.1",
    publicBaseUrl: origin,
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: `${origin}/id`,
    authJwksUrl: `${origin}/id/jwks`,
    authAudience: origin,
    webClientId: "mcpencode-web",
    sessionSecret: SESSION_SECRET,
    database: { host: "127.0.0.1", port: 5432, user: "mcpencode", password: "stub", database: "mcpencode", ssl: false },
  };
}

function stubAuthServer(issuer: string): AuthServerEndpoints {
  return {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

test("HTTP edit form: a stale form gets 409 and the latest copy; a current or legacy form saves", async () => {
  await withTestDatabase(async (db) => {
    const config = testConfig(34601);
    const app = createApp({ config, db, authServer: stubAuthServer(config.authIssuer) });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const csrf = "csrf-conflict";
    const cookie = `mcpencode_session=${await signSession(
      { sub: "pub-1", clientId: "mcpencode-web", role: "sa", csrf },
      SESSION_SECRET,
    )}`;
    const post = (id: string, form: Record<string, string>) =>
      fetch(`${base}/items/${id}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, ...form }),
        redirect: "manual",
      });
    try {
      const { item } = await printerItem(db);
      const editForm = await (await fetch(`${base}/items/${item.id}/edit`, { headers: { Cookie: cookie } })).text();
      const formRevision = /name="expected_revision" value="(\d+)"/.exec(editForm)?.[1];
      assert.ok(formRevision, "edit form carries the revision");

      await tick();
      await updateItem(db, item.id, { name: "Printer Queue Reset", body: "Saved by an agent meanwhile", labels: [] }, "agent");

      const stale = await post(item.id, { name: "Printer Queue Reset", body: "My stale edit", labels: "", expected_revision: formRevision });
      assert.equal(stale.status, 409);
      const html = await stale.text();
      assert.match(html, /Someone saved this item after you opened it/);
      assert.match(html, /Saved by an agent meanwhile/);
      assert.equal((await getItem(db, item.id, { publishedOnly: false }))?.body, "Saved by an agent meanwhile");

      const latest = /name="expected_revision" value="(\d+)"/.exec(html)?.[1];
      assert.ok(latest && latest !== formRevision);
      const retried = await post(item.id, { name: "Printer Queue Reset", body: "My edit, reapplied", labels: "", expected_revision: latest });
      assert.equal(retried.status, 302);

      const legacy = await post(item.id, { name: "Printer Queue Reset", body: "Old form without revision", labels: "" });
      assert.equal(legacy.status, 302);
      assert.equal((await getItem(db, item.id, { publishedOnly: false }))?.body, "Old form without revision");
    } finally {
      server.close();
    }
  });
});
