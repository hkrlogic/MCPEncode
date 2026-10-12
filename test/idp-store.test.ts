import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtVerify, SignJWT, importJWK, type JWK } from "jose";
import { createAccountGuard } from "../src/auth/account-guard.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { hashRefreshToken, type RefreshRecord } from "../src/auth/idp-store.ts";
import type { AppConfig } from "../src/config.ts";
import { accountStore } from "../src/db/accounts.ts";
import { openPrivateJwk, postgresIdpStore, sealPrivateJwk } from "../src/db/idp-store.ts";
import { withTestDatabase } from "./db.ts";

const SECRET = "test-session-secret-32-bytes-minimum!!";
const config = {
  publicBaseUrl: "http://127.0.0.1:3000",
  authIssuer: "http://127.0.0.1:3000/id",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mpos-web",
} as AppConfig;

function record(token: string, chainId: string, sub = "sub-1"): RefreshRecord {
  const now = Date.now();
  return {
    tokenHash: hashRefreshToken(token),
    chainId,
    sub,
    clientId: "mcp_x",
    resource: "http://127.0.0.1:3000",
    chainStartedAt: now,
    expiresAt: now + 60_000,
    usedAt: null,
  };
}

test("Postgres keeps registered clients", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresIdpStore(db, SECRET);
    await store.saveClient({ clientId: "mcp_a", clientName: "A", redirectUris: ["http://127.0.0.1:1/cb"], createdAt: 1 });
    assert.deepEqual(await store.findClient("mcp_a"), {
      clientId: "mcp_a",
      clientName: "A",
      redirectUris: ["http://127.0.0.1:1/cb"],
      createdAt: 1,
    });
    assert.equal(await store.findClient("mcp_b"), undefined);
    // An old registration that never signed in is pruned; one in use is kept.
    await store.saveClient({ clientId: "mcp_used", clientName: "", redirectUris: [], createdAt: 1 });
    await store.insertRefresh({ ...record("t-used", "chain-used"), clientId: "mcp_used" });
    await store.pruneClients(Date.now());
    assert.equal(await store.findClient("mcp_a"), undefined);
    assert.ok(await store.findClient("mcp_used"));
  });
});

test("Postgres refresh tokens rotate once and reuse revokes the chain", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresIdpStore(db, SECRET);
    await store.insertRefresh(record("first", "chain-1"));
    await store.insertRefresh(record("other", "chain-2"));
    const claimed = await store.claimRefresh(hashRefreshToken("first"), Date.now());
    assert.equal(claimed.status, "ok");
    await store.insertRefresh(record("second", "chain-1"));
    // Two racing claims of the same token: exactly one wins.
    await store.insertRefresh(record("race", "chain-3"));
    const race = await Promise.all([
      store.claimRefresh(hashRefreshToken("race"), Date.now()),
      store.claimRefresh(hashRefreshToken("race"), Date.now()),
    ]);
    assert.equal(race.filter((entry) => entry.status === "ok").length, 1);

    const reused = await store.claimRefresh(hashRefreshToken("first"), Date.now());
    assert.equal(reused.status, "reused");
    assert.equal((await store.claimRefresh(hashRefreshToken("second"), Date.now())).status, "missing");
    assert.equal((await store.claimRefresh(hashRefreshToken("other"), Date.now())).status, "ok");
    // Only hashes are stored.
    const rows = (await db.all("SELECT token_hash FROM oauth_refresh_tokens")) as { token_hash: string }[];
    assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)));
  });
});

test("Postgres revokes every chain of one account", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresIdpStore(db, SECRET);
    await store.insertRefresh(record("a1", "c1", "ada"));
    await store.insertRefresh(record("a2", "c2", "ada"));
    await store.insertRefresh(record("b1", "c3", "bob"));
    await store.revokeSubject("ada");
    assert.equal((await store.claimRefresh(hashRefreshToken("a1"), Date.now())).status, "missing");
    assert.equal((await store.claimRefresh(hashRefreshToken("a2"), Date.now())).status, "missing");
    assert.equal((await store.claimRefresh(hashRefreshToken("b1"), Date.now())).status, "ok");
  });
});

test("the signing key survives a restart and is encrypted at rest", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const first = await createEmbeddedIdp(config, accounts, { store: postgresIdpStore(db, SECRET) });
    const second = await createEmbeddedIdp(config, accounts, { store: postgresIdpStore(db, SECRET) });
    assert.equal(first.kid, second.kid);
    assert.notEqual(first.kid, "mpos-dev");

    const row = (await db.get("SELECT kid, private_jwk_enc FROM oauth_signing_keys")) as {
      kid: string;
      private_jwk_enc: string;
    };
    assert.equal(row.kid, first.kid);
    assert.match(row.private_jwk_enc, /^v1\./);
    assert.doesNotMatch(row.private_jwk_enc, /"d"/);
    const privateJwk = openPrivateJwk(row.private_jwk_enc, SECRET);
    assert.ok(privateJwk);
    // A token signed with the stored key verifies with the restarted IdP's public key.
    const token = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: first.kid })
      .setExpirationTime("1m")
      .sign(await importJWK(privateJwk as JWK, "RS256"));
    await jwtVerify(token, second.publicKey);

    // A different SESSION_SECRET cannot read it, so a new key is made.
    const rotated = await createEmbeddedIdp(config, accounts, {
      store: postgresIdpStore(db, "another-session-secret-32-bytes-min!!"),
    });
    assert.notEqual(rotated.kid, first.kid);
  });
});

test("sealed keys do not open with the wrong secret", () => {
  const sealed = sealPrivateJwk({ kty: "RSA", d: "secret" }, SECRET);
  assert.deepEqual(openPrivateJwk(sealed, SECRET), { kty: "RSA", d: "secret" });
  assert.equal(openPrivateJwk(sealed, `${SECRET}x`), undefined);
  assert.equal(openPrivateJwk("garbage", SECRET), undefined);
});

test("signing out everywhere in Postgres refuses earlier sessions", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const created = await accounts.create({ username: "ada", password: "correct horse battery", role: "readonly" });
    assert.ok(created.ok);
    const idp = await createEmbeddedIdp(config, accounts, { store: postgresIdpStore(db, SECRET) });
    const store = postgresIdpStore(db, SECRET);
    await store.insertRefresh(record("ada-token", "c-ada", created.account.id));
    const guard = createAccountGuard(accounts);
    const issuedAt = Math.floor(Date.now() / 1000) - 5;
    assert.equal((await guard(created.account.id, issuedAt)).allowed, true);
    await idp.revokeAccount(created.account.id);
    assert.equal((await guard(created.account.id, issuedAt)).allowed, false);
    assert.equal((await guard(created.account.id, Math.floor(Date.now() / 1000) + 2)).allowed, true);
    assert.equal((await store.claimRefresh(hashRefreshToken("ada-token"), Date.now())).status, "missing");
  });
});
