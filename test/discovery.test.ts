import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 3000,
  bindHost: "127.0.0.1",
  mcpResourceUrl: "http://127.0.0.1:3000/mcp",
  publicBaseUrl: "http://127.0.0.1:3000",
  authMode: "embedded",
  authIssuer: "http://127.0.0.1:3000/id",
  authJwksUrl: "http://127.0.0.1:3000/id/jwks",
  authAudience: "http://127.0.0.1:3000/mcp",
  webClientId: "mpos-web",
  sessionSecret: "x".repeat(32),
  databasePath: "./data/mpos.db",
};

test("OpenID discovery includes fields Cursor requires", async () => {
  const idp = await createEmbeddedIdp(config);
  const { metadata } = idp.endpoints;
  assert.deepEqual(metadata.subject_types_supported, ["public"]);
  assert.deepEqual(metadata.id_token_signing_alg_values_supported, ["RS256"]);
  assert.equal(metadata.jwks_uri, "http://127.0.0.1:3000/id/jwks");
});
