/** HTTP-level checks for fixes after the deep test: favicon, audit page sign-in, consent refusal. */
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import type { AppConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import { registeredClientId } from "./oauth-flow.ts";
import { withTestDatabase } from "./db.ts";

const origin = "http://127.0.0.1:34569";
const config = {
  port: 34569,
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
} as AppConfig;

const authServer = {
  metadata: { issuer: config.authIssuer, authorization_endpoint: `${config.authIssuer}/authorize`, token_endpoint: `${config.authIssuer}/token`, response_types_supported: ["code"] },
  authorizationEndpoint: `${config.authIssuer}/authorize`,
  tokenEndpoint: `${config.authIssuer}/token`,
} as unknown as AuthServerEndpoints;

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: async () => { server.close(); await once(server, "close"); } };
}

test("favicon is served, and /audit needs a sign-in", async () => {
  await withTestDatabase(async (db) => {
    const s = await listen(createApp({ config, db, authServer }));
    try {
      const icon = await fetch(`${s.base}/favicon.ico`);
      assert.equal(icon.status, 200);
      assert.match(icon.headers.get("content-type") ?? "", /svg/);
      const audit = await fetch(`${s.base}/audit`, { redirect: "manual" });
      assert.notEqual(audit.status, 200);
    } finally {
      await s.close();
    }
  });
});

test("an account with no access to the library is refused before consent, in plain words", async () => {
  const LIB = "00000000-0000-4000-8000-000000000001";
  const accounts = memoryAccountStore();
  assert.ok((await accounts.create({ username: "boss", password: "correct horse battery", role: "sa" })).ok);
  assert.ok((await accounts.create({ username: "ada", password: "correct horse battery", role: "readonly" })).ok);
  const idp = await createEmbeddedIdp({ ...config, authIssuer: "http://127.0.0.1:3000/id", authAudience: "http://127.0.0.1:3000", publicBaseUrl: "http://127.0.0.1:3000" } as AppConfig, accounts, {
    libraryName: async (id) => (id === LIB ? "Runbooks" : undefined),
    libraryRole: async () => undefined,
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const s = await listen(app);
  try {
    const callback = "http://127.0.0.1:33418/callback";
    const clientId = await registeredClientId(s.base, [callback]);
    const res = await fetch(`${s.base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: "code",
        code_challenge: await pkceChallenge("v".repeat(64)),
        code_challenge_method: "S256",
        resource: `http://127.0.0.1:3000/libraries/${LIB}/mcp/${"t".repeat(43)}`,
        username: "ada",
        password: "correct horse battery",
      }),
      redirect: "manual",
    });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /No access to this library/);
    assert.match(html, /Runbooks/);
    assert.doesNotMatch(html, /Allow access\?|IdP subject/);
  } finally {
    await s.close();
  }
});
