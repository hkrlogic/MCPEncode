/**
 * Reader key: one static Reader sign-in per library.
 * The secret is shown once, stored as a hash, and cannot write or read audit.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import {
  bearerFromAuthorization,
  hashReaderKey,
  isReaderKeyToken,
  generateReaderKey,
  readerKeyMatches,
  stashReaderKeyReveal,
  takeReaderKeyReveal,
} from "../src/auth/reader-key.ts";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import {
  addDraftItem,
  clearLibraryReaderKey,
  copyLibraryTemplate,
  createItem,
  createLibrary,
  getLibrary,
  getLibraryReaderKeyHash,
  grantLibraryAccess,
  issueLibraryReaderKey,
  publishItem,
  rotateLibraryConnectToken,
} from "../src/db/queries.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { libraryMcpUrl } from "../src/http/library-url.ts";
import { libraryPage } from "../src/http/pages.ts";
import { schemaForStarter } from "../src/items/library-schema.ts";
import {
  buildMcpServer,
  readerKeyInstructions,
  readerKeyLibraryContext,
  READER_KEY_REJECTED,
} from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";

const SESSION_SECRET = "test-session-secret-32-bytes-minimum!!";

function registeredToolNames(server: ReturnType<typeof buildMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(tools).sort();
}

test("a generated Reader key matches only its own hash", () => {
  const key = generateReaderKey();
  assert.equal(isReaderKeyToken(key), true);
  assert.equal(bearerFromAuthorization(`Bearer ${key}`), key);
  assert.equal(bearerFromAuthorization("Bearer not-a-key"), "not-a-key");
  assert.equal(isReaderKeyToken("not-a-key"), false);
  assert.equal(isReaderKeyToken(`${key}x`), false);
  const hash = hashReaderKey(key);
  assert.notEqual(hash, key);
  assert.equal(readerKeyMatches(key, hash), true);
  assert.equal(readerKeyMatches(`${key.slice(0, -1)}A`, hash), false);
  assert.equal(readerKeyMatches(key, null), false);
  assert.equal(readerKeyMatches(key, "not-hex"), false);
  assert.equal(bearerFromAuthorization(`Bearer ${"a".repeat(200)}`), undefined);
});

test("a reveal id shows the key once and only to the publisher who created it", () => {
  const id = stashReaderKeyReveal({ libraryId: "lib-1", sub: "alice", key: "mpr_secret" });
  assert.equal(takeReaderKeyReveal(id, "lib-2", "alice"), undefined);
  const again = stashReaderKeyReveal({ libraryId: "lib-1", sub: "alice", key: "mpr_secret" });
  assert.equal(takeReaderKeyReveal(again, "lib-1", "bob"), undefined);
  const third = stashReaderKeyReveal({ libraryId: "lib-1", sub: "alice", key: "mpr_secret" });
  assert.equal(takeReaderKeyReveal(third, "lib-1", "alice"), "mpr_secret");
  assert.equal(takeReaderKeyReveal(third, "lib-1", "alice"), undefined);
});

test("issuing a Reader key stores a hash, and rotating Connect keeps the key", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Windows patching", "alice", "general");
    const issued = await issueLibraryReaderKey(db, library.id, "alice");
    assert.ok(issued);
    assert.equal(isReaderKeyToken(issued.key), true);
    assert.equal(issued.library.readerKeyPrefix, issued.key.slice(0, 12));
    assert.equal(JSON.stringify(issued.library).includes(issued.key), false);

    const stored = await getLibraryReaderKeyHash(db, library.id);
    assert.equal(stored, hashReaderKey(issued.key));
    assert.notEqual(stored, issued.key);

    const rotatedConnect = await rotateLibraryConnectToken(db, library.id, "alice");
    assert.equal(rotatedConnect?.readerKeyPrefix, issued.library.readerKeyPrefix);
    assert.equal(await getLibraryReaderKeyHash(db, library.id), stored);

    const copied = await copyLibraryTemplate(db, library.id, "Patching copy", "alice");
    assert.equal(copied.ok, true);
    if (!copied.ok) return;
    assert.equal(copied.library.readerKeyPrefix ?? null, null);
    assert.equal(await getLibraryReaderKeyHash(db, copied.library.id), null);

    const replaced = await issueLibraryReaderKey(db, library.id, "alice");
    assert.ok(replaced);
    assert.notEqual(replaced.key, issued.key);
    assert.equal(readerKeyMatches(issued.key, await getLibraryReaderKeyHash(db, library.id)), false);
    assert.equal(readerKeyMatches(replaced.key, await getLibraryReaderKeyHash(db, library.id)), true);

    const cleared = await clearLibraryReaderKey(db, library.id, "alice");
    assert.equal(cleared?.readerKeyPrefix ?? null, null);
    assert.equal(await getLibraryReaderKeyHash(db, library.id), null);
  });
});

test("a Reader key registers lookup tools only", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Windows patching", "alice", "general");
    const auth: AuthInfo = {
      token: "reader-key",
      clientId: "library-reader-key",
      scopes: ["records.read"],
      extra: { sub: "someone-else", role: "sa", readerKey: true },
    };
    const server = buildMcpServer(db, auth, readerKeyLibraryContext(library));
    const names = registeredToolNames(server);
    assert.deepEqual(names, ["list_items", "open_item", "whoami"]);
    const instructions = readerKeyInstructions(library.name, schemaForStarter("general"));
    assert.match(instructions, /published items only/);
    assert.doesNotMatch(instructions, /create_item and update_item save drafts/);
  });
});

test("the publisher page offers a Reader key and a reader page does not", () => {
  const library = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Windows patching",
    template: "general" as const,
    writeMode: "reviewed" as const,
    schema: schemaForStarter("general"),
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: null,
    fieldProposalUnreadable: false,
    connectToken: "test-connect-token-aaaaaaaaaaaaaaaaaa",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
  };
  const shell = {
    csrf: "token",
    mcpUrl: "http://127.0.0.1:3000/libraries/x/mcp/test-connect-token-aaaaaaaaaaaaaaaaaa",
    shellLibraries: [],
  };
  const publisherHtml = libraryPage({
    ...shell,
    access: accessFromLibraryRole({ sub: "alice", clientId: "test", libraryRole: "publisher" }),
    library,
    items: [],
  });
  assert.match(publisherHtml, /Create Reader key/);
  assert.match(publisherHtml, /action="\/libraries\/[^"]+\/reader-key"/);
  assert.doesNotMatch(publisherHtml, /mpr_/);

  const readerHtml = libraryPage({
    ...shell,
    access: accessFromLibraryRole({ sub: "carol", clientId: "test", libraryRole: "reader" }),
    library: { ...library, readerKeyPrefix: "mpr_abcdefgh" },
    items: [],
  });
  assert.doesNotMatch(readerHtml, /Create Reader key/);
  assert.doesNotMatch(readerHtml, /reader-key/);
  assert.doesNotMatch(readerHtml, /mpr_abcdefgh/);
});

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
    webClientId: "mpos-web",
    sessionSecret: SESSION_SECRET,
    database: {
      host: "127.0.0.1",
      port: 5432,
      user: "mpos",
      password: "stub-not-a-real-password",
      database: "mpos",
      ssl: false,
    },
  };
}

function stubAuthServer(issuer: string): AuthServerEndpoints {
  return {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

async function sessionCookie(sub: string, csrf: string, role: "sa" | "readonly") {
  const token = await signSession({ sub, clientId: "mpos-web", role, csrf }, SESSION_SECRET);
  return `mpos_session=${token}`;
}

test("HTTP: Reader key is shown once, stays Reader, and rejects a leaked key", async () => {
  await withTestDatabase(async (db) => {
    const config = testConfig(34567);
    const app = createApp({ config, db, authServer: stubAuthServer(config.authIssuer) });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const library = await createLibrary(db, "Windows patching", "alice", "general");
      await grantLibraryAccess(db, {
        libraryId: library.id,
        subject: "carol",
        role: "reader",
        grantedBy: "alice",
      });
      const draft = await addDraftItem(
        db,
        library.id,
        { name: "Draft runbook", summary: "Not live", body: "Hidden", labels: [] },
        "alice",
      );
      assert.equal(draft.ok, true);
      const live = await createItem(
        db,
        { name: "Patch Tuesday", summary: "Monthly updates", body: "Apply the approved set.", labels: [] },
        "alice",
        library.id,
        { status: "published" },
      );
      assert.equal(live.status, "published");

      const csrf = "csrf-alice";
      const cookie = await sessionCookie("alice", csrf, "sa");
      const created = await fetch(`${base}/libraries/${library.id}/reader-key`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf }),
      });
      assert.equal(created.status, 302);
      const reveal = created.headers.getSetCookie().find((row) => row.startsWith("mpos_reader_reveal="));
      assert.ok(reveal);
      const revealPair = reveal.split(";")[0] ?? "";
      assert.match(reveal, /HttpOnly/);
      assert.doesNotMatch(reveal, /mpr_/);

      const shown = await fetch(`${base}/libraries/${library.id}`, {
        headers: { cookie: `${cookie}; ${revealPair}` },
      });
      assert.equal(shown.status, 200);
      assert.equal(shown.headers.get("cache-control"), "no-store");
      const html = await shown.text();
      const key = html.match(/id="reader-key">([^<]+)</)?.[1];
      assert.ok(key);
      assert.equal(isReaderKeyToken(key), true);
      assert.match(html, /requiresOAuth: false/);
      assert.match(html, new RegExp(`Authorization: Bearer ${key}`));

      const again = await fetch(`${base}/libraries/${library.id}`, { headers: { cookie } });
      const againHtml = await again.text();
      assert.equal(againHtml.includes(key), false);
      assert.match(againHtml, /A Reader key is active/);

      const readerCookie = await sessionCookie("carol", "csrf-carol", "readonly");
      const readerPage = await fetch(`${base}/libraries/${library.id}`, {
        headers: { cookie: readerCookie },
      });
      const readerHtml = await readerPage.text();
      assert.equal(readerHtml.includes("Create Reader key"), false);
      assert.equal(readerHtml.includes(key), false);

      const readerPost = await fetch(`${base}/libraries/${library.id}/reader-key`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: readerCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "csrf-carol" }),
      });
      assert.equal(readerPost.status, 403);

      const badCsrf = await fetch(`${base}/libraries/${library.id}/reader-key`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "nope" }),
      });
      assert.equal(badCsrf.status, 403);

      const mcpPath = new URL(libraryMcpUrl(base, library.id, (await getLibrary(db, library.id))!.connectToken)).pathname;
      const initBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "reader-key-test", version: "0" },
        },
      };
      const noAuth = await mcpPost(base, mcpPath, undefined, initBody);
      assert.equal(noAuth.status, 401);
      assert.match(noAuth.www ?? "", /Bearer/);

      const badKey = await mcpPost(base, mcpPath, generateReaderKey(), initBody);
      assert.equal(badKey.status, 401);
      assert.match(badKey.text, new RegExp(READER_KEY_REJECTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(badKey.www, null);

      const other = await createLibrary(db, "HR handbook", "alice", "general");
      const otherPath = new URL(libraryMcpUrl(base, other.id, other.connectToken)).pathname;
      const wrongLibrary = await mcpPost(base, otherPath, key, initBody);
      assert.equal(wrongLibrary.status, 401);

      const okInit = await mcpPost(base, mcpPath, key, initBody);
      assert.equal(okInit.status, 200, okInit.text.slice(0, 500));
      assert.equal(okInit.text.includes(key), false);

      const listed = await mcpCall(base, mcpPath, key, "tools/list", {});
      assert.equal(listed.status, 200, listed.text.slice(0, 800));
      assert.match(listed.text, /list_items/);
      assert.equal(listed.text.includes("create_item"), false);
      assert.equal(listed.text.includes("list_audit"), false);

      const found = await mcpCall(base, mcpPath, key, "tools/call", {
        name: "list_items",
        arguments: { q: "Patch" },
      });
      assert.equal(found.status, 200, found.text.slice(0, 800));
      assert.match(found.text, /Patch Tuesday/);
      assert.equal(found.text.includes("Draft runbook"), false);

      const draftLookup = await mcpCall(base, mcpPath, key, "tools/call", {
        name: "list_items",
        arguments: { q: "Draft runbook" },
      });
      assert.equal(draftLookup.text.includes("Draft runbook"), false);

      if (!draft.ok) return;
      await publishItem(db, draft.item.id, "alice");
      const nowLive = await mcpCall(base, mcpPath, key, "tools/call", {
        name: "list_items",
        arguments: { q: "Draft runbook" },
      });
      assert.match(nowLive.text, /Draft runbook/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

async function mcpPost(
  base: string,
  path: string,
  key: string | undefined,
  body: unknown,
  session?: string | null,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (key) headers.authorization = `Bearer ${key}`;
  if (session) headers["mcp-session-id"] = session;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    session: response.headers.get("mcp-session-id"),
    www: response.headers.get("www-authenticate"),
  };
}

async function mcpCall(base: string, path: string, key: string, method: string, params: unknown) {
  const init = await mcpPost(base, path, key, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "reader-key-test", version: "0" },
    },
  });
  if (init.status !== 200) return init;
  if (init.session) {
    await mcpPost(
      base,
      path,
      key,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      init.session,
    );
  }
  return mcpPost(
    base,
    path,
    key,
    { jsonrpc: "2.0", id: 2, method, params },
    init.session,
  );
}
