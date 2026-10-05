import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 3000,
  bindHost: "127.0.0.1",
  publicBaseUrl: "http://127.0.0.1:3000",
  allowedHosts: [],
  authMode: "embedded",
  authIssuer: "http://127.0.0.1:3000/id",
  authJwksUrl: "http://127.0.0.1:3000/id/jwks",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mpos-web",
  sessionSecret: "x".repeat(32),
  database: {
    host: "127.0.0.1",
    port: 5432,
    user: "mpos",
    password: "local-test-only",
    database: "mpos",
    ssl: false,
  },
};

test("OpenID discovery includes fields Cursor requires", async () => {
  const idp = await createEmbeddedIdp(config);
  const { metadata } = idp.endpoints;
  assert.deepEqual(metadata.subject_types_supported, ["public"]);
  assert.deepEqual(metadata.id_token_signing_alg_values_supported, ["RS256"]);
  assert.equal(metadata.jwks_uri, "http://127.0.0.1:3000/id/jwks");
});
