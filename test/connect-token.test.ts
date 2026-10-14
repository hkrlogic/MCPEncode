/**
 * Connect token: in the link path, or in X-Library-Token on the bare
 * /libraries/:id/mcp so it stays out of URLs and proxy logs.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { createLibrary, issueLibraryReaderKey, rotateLibraryConnectToken } from "../src/db/queries.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { libraryMcpBaseUrl } from "../src/http/library-url.ts";
import { withTestDatabase } from "./db.ts";

function testConfig(): AppConfig {
  const origin = "http://127.0.0.1:34568";
  return {
    port: 34568,
    bindHost: "127.0.0.1",
    publicBaseUrl: origin,
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: `${origin}/id`,
    authJwksUrl: `${origin}/id/jwks`,
    authAudience: origin,
    webClientId: "mcpencode-web",
    sessionSecret: "test-session-secret-32-bytes-minimum!!",
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
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "connect-token-test", version: "0" } },
};

async function post(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(INIT),
  });
  return { status: response.status, text: await response.text(), www: response.headers.get("www-authenticate") };
}

test("X-Library-Token opens the library on the bare MCP path; the link form keeps working", async () => {
  await withTestDatabase(async (db) => {
    const config = testConfig();
    const app = createApp({ config, db, authServer: stubAuthServer(config.authIssuer) });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const library = await createLibrary(db, "Windows patching", "alice", "general");
      const issued = await issueLibraryReaderKey(db, library.id, "alice");
      assert.ok(issued);
      const token = library.connectToken;
      const bare = `${base}/libraries/${library.id}/mcp`;

      // No header and no Reader key: still the retired-link answer.
      const missing = await post(bare, {});
      assert.equal(missing.status, 410);
      assert.match(missing.text, /X-Library-Token/);

      // A Reader key works on the bare path on its own: no Connect token needed.
      const readerOnly = await post(bare, { authorization: `Bearer ${issued.key}` });
      assert.equal(readerOnly.status, 200, readerOnly.text);
      assert.match(readerOnly.text, /serverInfo/);

      // Wrong header: not found, same as a wrong link.
      const wrong = await post(bare, { authorization: `Bearer ${issued.key}`, "x-library-token": "x".repeat(43) });
      assert.equal(wrong.status, 404);

      const viaHeader = await post(bare, { authorization: `Bearer ${issued.key}`, "x-library-token": token });
      assert.equal(viaHeader.status, 200, viaHeader.text);
      assert.match(viaHeader.text, /serverInfo/);

      const viaPath = await post(`${bare}/${token}`, { authorization: `Bearer ${issued.key}` });
      assert.equal(viaPath.status, 200, viaPath.text);

      // Without a bearer the challenge points at metadata that does not carry the token.
      const challenge = await post(bare, { "x-library-token": token });
      assert.equal(challenge.status, 401);
      assert.ok(challenge.www?.includes(`/.well-known/oauth-protected-resource/libraries/${library.id}/mcp"`));
      assert.equal(challenge.www?.includes(token), false);
      const metadata = (await (
        await fetch(`${base}/.well-known/oauth-protected-resource/libraries/${library.id}/mcp`)
      ).json()) as { resource: string };
      assert.equal(metadata.resource, libraryMcpBaseUrl(config.publicBaseUrl, library.id));
      // It answers for any well-formed id, so it says nothing about which libraries exist.
      const unknown = await fetch(`${base}/.well-known/oauth-protected-resource/libraries/${crypto.randomUUID()}/mcp`);
      assert.equal(unknown.status, 200);
      assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/libraries/nope/mcp`)).status, 404);

      // Rotating the link stops the old header value too.
      await rotateLibraryConnectToken(db, library.id, "alice");
      const rotated = await post(bare, { authorization: `Bearer ${issued.key}`, "x-library-token": token });
      assert.equal(rotated.status, 404);
    } finally {
      server.close();
    }
  });
});
