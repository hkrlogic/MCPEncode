import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createLocalJWKSet } from "jose";
import { jwtVerify } from "jose";
import { createTokenVerifier } from "../src/auth/verifier.ts";
import { accessFromAuthInfo } from "../src/auth/verifier.ts";

const issuer = "http://127.0.0.1:8080/realms/mpos";
const audience = "http://127.0.0.1:3000/mcp";

test("accepts an audience-bound token with the editor role", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({
    sub: "editor-1",
    azp: "mpos-web",
    realm_access: { roles: ["mpos-editor"] },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({ issuer, audience, localKey: publicKey });
  const auth = await verifier.verifyAccessToken(token);
  const access = accessFromAuthInfo(auth);
  assert.equal(access.role, "edit");
  assert.equal(access.sub, "editor-1");
  assert.ok(access.permissions.includes("records.delete"));
});

test("rejects a token minted for a different audience", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({
    sub: "editor-1",
    realm_access: { roles: ["mpos-editor"] },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience("http://evil.example/mcp")
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({ issuer, audience, localKey: publicKey });
  await assert.rejects(() => verifier.verifyAccessToken(token));
});

test("rejects a token with no MCPEncode role", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({ sub: "nobody" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(privateKey);

  const verifier = createTokenVerifier({ issuer, audience, localKey: publicKey });
  await assert.rejects(() => verifier.verifyAccessToken(token));
});

test("local JWKS round-trip still verifies", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k1";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({ sub: "x" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(privateKey);
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  assert.equal(payload.sub, "x");
});
