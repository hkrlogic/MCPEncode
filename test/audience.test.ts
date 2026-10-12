import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { libraryTokenAudience } from "../src/auth/audience.ts";
import type { AppConfig } from "../src/config.ts";
import { createTokenVerifier } from "../src/auth/verifier.ts";

const libraryUrl =
  "http://127.0.0.1:3000/libraries/00000000-0000-4000-8000-000000000001/mcp/test-connect-token-dddddddddddddddddd";
const projectAudience = "123456789012345678";

function config(authMode: AppConfig["authMode"]): AppConfig {
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:3000",
    allowedHosts: [],
    authMode,
    authIssuer: "http://127.0.0.1:8080",
    authJwksUrl: "",
    authAudience: authMode === "oidc" ? projectAudience : "http://127.0.0.1:3000",
    webClientId: "web",
    sessionSecret: "x".repeat(32),
    database: {
      host: "127.0.0.1",
      port: 5432,
      user: "mcpencode",
      password: "local-test-only",
      database: "mcpencode",
      ssl: false,
    },
  };
}

test("embedded mode binds a library token to that library URL", () => {
  assert.equal(libraryTokenAudience(config("embedded"), libraryUrl), libraryUrl);
});

test("oidc mode binds every library token to the project audience", () => {
  assert.equal(libraryTokenAudience(config("oidc"), libraryUrl), projectAudience);
});

test("oidc mode uses AUTH_MCP_AUDIENCE when set, so web tokens cannot open MCP", async () => {
  const mcpAudience = "987654321098765432";
  const withMcp = { ...config("oidc"), authMcpAudience: mcpAudience };
  assert.equal(libraryTokenAudience(withMcp, libraryUrl), mcpAudience);
  // Embedded mode ignores it.
  assert.equal(libraryTokenAudience({ ...config("embedded"), authMcpAudience: mcpAudience }, libraryUrl), libraryUrl);

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const sign = (aud: string) =>
    new SignJWT({ sub: "editor-1", "urn:zitadel:iam:org:project:roles": { "mpos-editor": { "999": "x" } } })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://127.0.0.1:8080")
      .setAudience(aud)
      .setExpirationTime("5m")
      .sign(privateKey);
  const verifier = createTokenVerifier({
    issuer: "http://127.0.0.1:8080",
    audience: libraryTokenAudience(withMcp, libraryUrl),
    localKey: publicKey,
  });
  await verifier.verifyAccessToken(await sign(mcpAudience));
  await assert.rejects(verifier.verifyAccessToken(await sign(projectAudience)));
});

test("a Zitadel role claim is accepted for the project audience", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({
    sub: "editor-1",
    azp: "web-client",
    "urn:zitadel:iam:org:project:roles": {
      "mpos-editor": { "999": "mcpencode.127.0.0.1" },
    },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("http://127.0.0.1:8080")
    .setAudience([projectAudience, "web-client"])
    .setExpirationTime("5m")
    .sign(privateKey);

  const audience = libraryTokenAudience(config("oidc"), libraryUrl);
  const verifier = createTokenVerifier({
    issuer: "http://127.0.0.1:8080",
    audience,
    localKey: publicKey,
  });
  const auth = await verifier.verifyAccessToken(token);
  assert.equal(auth.extra?.role, "sa");
  assert.equal(auth.extra?.sub, "editor-1");
});

test("a Zitadel read-only role stays read-only", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({
    sub: "reader-1",
    "urn:zitadel:iam:org:project:roles": {
      "mpos-readonly": { "999": "mcpencode.127.0.0.1" },
    },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("http://127.0.0.1:8080")
    .setAudience(projectAudience)
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({
    issuer: "http://127.0.0.1:8080",
    audience: projectAudience,
    localKey: publicKey,
  });
  const auth = await verifier.verifyAccessToken(token);
  assert.equal(auth.extra?.role, "readonly");
});

test("embedded mode still rejects a token minted for another library", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const other =
    "http://127.0.0.1:3000/libraries/00000000-0000-4000-8000-000000000002/mcp/test-connect-token-eeeeeeeeeeeeeeeeee";
  const token = await new SignJWT({
    sub: "editor-1",
    realm_access: { roles: ["mpos-editor"] },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("http://127.0.0.1:8080")
    .setAudience(other)
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({
    issuer: "http://127.0.0.1:8080",
    audience: libraryTokenAudience(config("embedded"), libraryUrl),
    localKey: publicKey,
  });
  await assert.rejects(() => verifier.verifyAccessToken(token));
});

test("a token for a different project audience is rejected", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({
    sub: "editor-1",
    "urn:zitadel:iam:org:project:roles": { "mpos-editor": { "1": "org" } },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("http://127.0.0.1:8080")
    .setAudience("999")
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({
    issuer: "http://127.0.0.1:8080",
    audience: libraryTokenAudience(config("oidc"), libraryUrl),
    localKey: publicKey,
  });
  await assert.rejects(() => verifier.verifyAccessToken(token));
});
