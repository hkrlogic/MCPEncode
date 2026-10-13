/**
 * Connect tokens are stored as SHA-256 only. The full link is shown once
 * (Create, Copy, Rotate); later loads show a masked link.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import { createLibrary, getLibrary, getLibraryConnectTokenHash, issueLibraryReaderKey, rotateLibraryConnectToken } from "../src/db/queries.ts";
import type { Database } from "../src/db/types.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { hashConnectToken, maskedLibraryMcpUrl } from "../src/http/library-url.ts";
import { disposableDatabase, withTestDatabase } from "./db.ts";

const SESSION_SECRET = "test-session-secret-32-bytes-minimum!!";

function testConfig(): AppConfig {
  const origin = "http://127.0.0.1:34571";
  return {
    port: 34571,
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

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hash-test", version: "0" } },
};

async function mcp(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(INIT),
  });
  return { status: response.status, text: await response.text() };
}

async function withApp(db: Database, run: (base: string) => Promise<void>): Promise<void> {
  const config = testConfig();
  const app = createApp({ config, db, authServer: stubAuthServer(config.authIssuer) });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

/** Every text column of every libraries/audit row, for "is the plaintext anywhere" checks. */
async function dumpTables(db: Database): Promise<string> {
  const libraries = await db.all("SELECT * FROM libraries");
  const audit = await db.all("SELECT * FROM audit_events");
  return JSON.stringify({ libraries, audit });
}

test("migration 019 hashes existing tokens in place; old links keep working; re-run is a no-op", async () => {
  const { config, cleanup } = await disposableDatabase();
  resetDatabaseCache();
  let db: Database | undefined;
  try {
    db = await openDatabase(config, { migrate: false });
    // Build the schema as it was before 019 (v0.2.0).
    const files = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql") && name < "019")
      .sort();
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (version))`);
    for (const file of files) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", file, Date.now());
    }
    const oldToken = "OldLinkToken_0123456789abcdefghijklmnopqrstu"; // 43 chars, base64url
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO libraries (id, name, template, connect_token, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'Legacy', 'general', ?, 'alice', 'alice', 0, 0)`,
      id,
      oldToken,
    );
    await db.run(
      "INSERT INTO library_access (library_id, subject, role, granted_by, created_at) VALUES (?, 'alice', 'publisher', 'alice', 0)",
      id,
    );

    await applyMigrations(db);

    const columns = (await db.all(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'libraries' AND column_name LIKE 'connect_token%'",
    )) as { name: string }[];
    assert.deepEqual(columns.map((c) => c.name).sort(), ["connect_token_hash", "connect_token_last4"]);
    assert.equal(await getLibraryConnectTokenHash(db, id), hashConnectToken(oldToken));
    assert.equal((await getLibrary(db, id))?.connectTokenLast4, "rstu");
    assert.equal((await dumpTables(db)).includes(oldToken), false);

    // Idempotent: running the file again changes nothing.
    const before = await dumpTables(db);
    await db.exec(await readFile(new URL("../migrations/019_hash_connect_tokens.sql", import.meta.url), "utf8"));
    assert.equal(await dumpTables(db), before);

    await withApp(db, async (base) => {
      const viaPath = await mcp(`${base}/libraries/${id}/mcp/${oldToken}`);
      assert.equal(viaPath.status, 401, viaPath.text); // token accepted; OAuth challenge next
      const viaHeader = await mcp(`${base}/libraries/${id}/mcp`, { "x-library-token": oldToken });
      assert.equal(viaHeader.status, 401, viaHeader.text);
      const wrong = await mcp(`${base}/libraries/${id}/mcp/${"x".repeat(43)}`);
      assert.equal(wrong.status, 404);
    });
  } finally {
    await db?.close();
    resetDatabaseCache();
    await cleanup();
  }
});

test("new and rotated tokens are stored only as hashes; rotate kills the old one (path and header)", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Hashed", "alice", "general");
    const key = await issueLibraryReaderKey(db, library.id, "alice");
    assert.ok(key);
    assert.equal((await dumpTables(db)).includes(library.connectToken), false);
    assert.equal(await getLibraryConnectTokenHash(db, library.id), hashConnectToken(library.connectToken));
    const reread = await getLibrary(db, library.id);
    assert.equal(Object.hasOwn(reread ?? {}, "connectToken"), false);

    await withApp(db, async (base) => {
      const auth = { authorization: `Bearer ${key.key}` };
      assert.equal((await mcp(`${base}/libraries/${library.id}/mcp/${library.connectToken}`, auth)).status, 200);
      assert.equal(
        (await mcp(`${base}/libraries/${library.id}/mcp`, { ...auth, "x-library-token": library.connectToken })).status,
        200,
      );
      const rotated = await rotateLibraryConnectToken(db, library.id, "alice");
      assert.ok(rotated);
      assert.equal((await dumpTables(db)).includes(rotated.connectToken), false);
      assert.equal((await mcp(`${base}/libraries/${library.id}/mcp/${library.connectToken}`, auth)).status, 404);
      assert.equal(
        (await mcp(`${base}/libraries/${library.id}/mcp`, { ...auth, "x-library-token": library.connectToken })).status,
        404,
      );
      assert.equal((await mcp(`${base}/libraries/${library.id}/mcp/${rotated.connectToken}`, auth)).status, 200);
      assert.equal(
        (await mcp(`${base}/libraries/${library.id}/mcp`, { ...auth, "x-library-token": rotated.connectToken })).status,
        200,
      );
    });
  });
});

test("HTTP: the full Connect link is shown once after Create and Rotate, never in pages, logs, or audit", async () => {
  await withTestDatabase(async (db) => {
    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const name of ["log", "warn", "error", "info"] as const) {
      console[name] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
    }
    try {
      await withApp(db, async (base) => {
        const csrf = "csrf-alice";
        const token = await signSession({ sub: "alice", clientId: "mcpencode-web", role: "sa", csrf }, SESSION_SECRET);
        const cookie = `mcpencode_session=${token}`;
        const form = { cookie, "content-type": "application/x-www-form-urlencoded" };

        const created = await fetch(`${base}/libraries`, {
          method: "POST",
          redirect: "manual",
          headers: form,
          body: new URLSearchParams({ csrf, name: "Once", template: "general", write_mode: "reviewed" }),
        });
        assert.equal(created.status, 302, await created.text());
        const libraryPath = created.headers.get("location") ?? "";
        const libraryId = libraryPath.split("/").pop()?.split("?")[0] ?? "";
        const reveal = created.headers.getSetCookie().find((row) => row.startsWith("mcpencode_connect_reveal="));
        assert.ok(reveal);
        assert.match(reveal, /HttpOnly/);
        const pair = reveal.split(";")[0] ?? "";

        const shown = await fetch(`${base}/libraries/${libraryId}`, { headers: { cookie: `${cookie}; ${pair}` } });
        assert.equal(shown.headers.get("cache-control"), "no-store");
        const html = await shown.text();
        const link = html.match(/id="mcp-url">([^<]+)</)?.[1] ?? "";
        const first = link.split("/mcp/")[1] ?? "";
        assert.match(first, /^[A-Za-z0-9_-]{43}$/);
        assert.match(html, /won't see it again/);

        // Same reveal cookie again: consumed. A fresh load shows only the masked link.
        for (const headers of [{ cookie: `${cookie}; ${pair}` }, { cookie }]) {
          const later = await (await fetch(`${base}/libraries/${libraryId}`, { headers })).text();
          assert.equal(later.includes(first), false);
          assert.ok(later.includes(maskedLibraryMcpUrl(testConfig().publicBaseUrl, libraryId, first.slice(-4))));
          assert.match(later, /connect\/rotate/);
        }

        const rotated = await fetch(`${base}/libraries/${libraryId}/connect/rotate`, {
          method: "POST",
          redirect: "manual",
          headers: form,
          body: new URLSearchParams({ csrf }),
        });
        assert.equal(rotated.status, 302);
        const pair2 = rotated.headers.getSetCookie().find((row) => row.startsWith("mcpencode_connect_reveal="))?.split(";")[0];
        assert.ok(pair2);
        const html2 = await (await fetch(`${base}/libraries/${libraryId}`, { headers: { cookie: `${cookie}; ${pair2}` } })).text();
        const second = (html2.match(/id="mcp-url">([^<]+)</)?.[1] ?? "").split("/mcp/")[1] ?? "";
        assert.match(second, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(second, first);

        // Old link is dead, new link authenticates (401 = token accepted, OAuth next).
        assert.equal((await mcp(`${base}/libraries/${libraryId}/mcp/${first}`)).status, 404);
        assert.equal((await mcp(`${base}/libraries/${libraryId}/mcp/${second}`)).status, 401);

        const libsHtml = await (await fetch(`${base}/libraries`, { headers: { cookie } })).text();
        const dump = await dumpTables(db);
        for (const secret of [first, second]) {
          assert.equal(dump.includes(secret), false);
          assert.equal(libsHtml.includes(secret), false);
          assert.equal(logged.some((line) => line.includes(secret)), false);
        }
      });
    } finally {
      Object.assign(console, originals);
    }
  });
});
