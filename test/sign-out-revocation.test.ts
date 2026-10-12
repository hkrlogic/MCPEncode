import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAccountGuard } from "../src/auth/account-guard.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { hashRefreshToken } from "../src/auth/idp-store.ts";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import { accountStore } from "../src/db/accounts.ts";
import { postgresIdpStore } from "../src/db/idp-store.ts";
import { SESSION_COOKIE, sessionAccess } from "../src/http/helpers.ts";
import { registerAccountRoutes } from "../src/http/routes/accounts.ts";
import { registerAuthRoutes } from "../src/http/routes/auth.ts";
import type { AppRouteContext } from "../src/http/routes/context.ts";
import type { Database } from "../src/db/types.ts";
import type { Request } from "express";
import { withTestDatabase } from "./db.ts";

const SECRET = "s".repeat(10) + "-sign-out-test-secret-0123456789";
const PASSWORD = "correct horse battery";
const config = {
  publicBaseUrl: "http://127.0.0.1:3000",
  authIssuer: "http://127.0.0.1:3000/id",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mpos-web",
  authMode: "embedded",
  sessionSecret: SECRET,
} as AppConfig;

async function setup(db: Database) {
  const accounts = accountStore(db);
  const sa = await accounts.createFirst({ username: "boss", password: PASSWORD });
  const ada = await accounts.create({ username: "ada", password: PASSWORD, role: "readonly" });
  assert.ok(sa.ok && ada.ok);
  const store = postgresIdpStore(db, SECRET);
  const idp = await createEmbeddedIdp(config, accounts, { store });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.locals.accountGuard = createAccountGuard(accounts);
  const ctx = {
    config,
    db,
    authServer: idp.endpoints,
    verifier: { verifyAccessToken: async () => ({}) },
    revokeAccount: idp.revokeAccount,
  } as unknown as AppRouteContext;
  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const refreshFor = async (sub: string, token: string) => {
    const now = Date.now();
    await store.insertRefresh({
      tokenHash: hashRefreshToken(token),
      chainId: crypto.randomUUID(),
      sub,
      clientId: "mcp_x",
      resource: config.authAudience,
      chainStartedAt: now,
      expiresAt: now + 60_000,
      usedAt: null,
    });
  };
  return {
    accounts,
    store,
    sa: sa.account,
    ada: ada.account,
    base: `http://127.0.0.1:${port}`,
    refreshFor,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function sessionRequest(token: string, app: { locals: Record<string, unknown> }): Request {
  return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` }, app } as unknown as Request;
}

test("sign-out revokes the account's refresh tokens and earlier sessions", async () => {
  await withTestDatabase(async (db) => {
    const s = await setup(db);
    try {
      await s.refreshFor(s.ada.id, "ada-refresh");
      await s.refreshFor(s.sa.id, "boss-refresh");
      const csrf = "c";
      const session = await signSession({ sub: s.ada.id, clientId: "mpos-web", role: "readonly", csrf }, SECRET);
      const other = await signSession({ sub: s.ada.id, clientId: "mpos-web", role: "readonly", csrf }, SECRET);
      const locals = { locals: { accountGuard: createAccountGuard(s.accounts) } };
      assert.ok(await sessionAccess(sessionRequest(other, locals), config));

      const res = await fetch(`${s.base}/logout`, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` },
        redirect: "manual",
      });
      assert.equal(res.status, 302);
      assert.equal((await s.store.claimRefresh(hashRefreshToken("ada-refresh"), Date.now())).status, "missing");
      // Another person's sign-in is untouched.
      assert.equal((await s.store.claimRefresh(hashRefreshToken("boss-refresh"), Date.now())).status, "ok");
      // A copy of the session from another browser stops working.
      assert.equal(await sessionAccess(sessionRequest(other, locals), config), undefined);
    } finally {
      await s.close();
    }
  });
});

test("a password reset revokes that account's refresh tokens and sessions", async () => {
  await withTestDatabase(async (db) => {
    const s = await setup(db);
    try {
      await s.refreshFor(s.ada.id, "ada-refresh");
      const csrf = "csrf-reset";
      const boss = await signSession({ sub: s.sa.id, clientId: "mpos-web", role: "sa", csrf }, SECRET);
      const adaSession = await signSession({ sub: s.ada.id, clientId: "mpos-web", role: "readonly", csrf: "a" }, SECRET);
      const res = await fetch(`${s.base}/accounts/${s.ada.id}/password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(boss)}`,
        },
        body: new URLSearchParams({ csrf, password: "a brand new password" }),
        redirect: "manual",
      });
      assert.equal(res.status, 302);
      assert.equal((await s.store.claimRefresh(hashRefreshToken("ada-refresh"), Date.now())).status, "missing");
      const locals = { locals: { accountGuard: createAccountGuard(s.accounts) } };
      assert.equal(await sessionAccess(sessionRequest(adaSession, locals), config), undefined);
    } finally {
      await s.close();
    }
  });
});
