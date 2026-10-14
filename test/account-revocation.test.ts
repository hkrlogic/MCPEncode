import assert from "node:assert/strict";
import express from "express";
import type { Request } from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createAccountGuard } from "../src/auth/account-guard.ts";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import { SESSION_COOKIE, sessionAccess } from "../src/http/helpers.ts";
import { createLibrary } from "../src/db/queries.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import {
  ACCOUNT_UNAVAILABLE,
  FORBIDDEN_LIBRARY,
  resolveLibraryMcpAccess,
} from "../src/mcp/server.ts";
import { withTestDatabase } from "./db.ts";
import { registeredClientId, signInForCode } from "./oauth-flow.ts";

/** Client id registered by the latest startIdp (tests in this file run one at a time). */
let mcpClientId = "";

const PASSWORD = "correct horse battery";
const SECRET = "test-session-secret-32-bytes-minimum!!";

async function twoSas() {
  const accounts = memoryAccountStore();
  const ada = await accounts.create({ username: "ada", password: PASSWORD, role: "sa" });
  const bob = await accounts.create({ username: "bob", password: PASSWORD, role: "sa" });
  assert.ok(ada.ok && bob.ok);
  return { accounts, ada: ada.account, bob: bob.account };
}

test("the guard allows an active account and reports its current role", async () => {
  const { accounts, ada } = await twoSas();
  const guard = createAccountGuard(accounts);
  assert.deepEqual(await guard(ada.id), { allowed: true, role: "sa" });
  await accounts.setSa(ada.id, false);
  assert.deepEqual(await guard(ada.id), { allowed: true, role: "readonly" });
});

test("the guard refuses a disabled account and one that does not exist", async () => {
  const { accounts, ada } = await twoSas();
  const guard = createAccountGuard(accounts);
  await accounts.setDisabled(ada.id, true);
  assert.deepEqual(await guard(ada.id), { allowed: false, reason: "disabled" });
  assert.deepEqual(await guard("no-such-account"), { allowed: false, reason: "disabled" });
});

function requestWithSession(token: string, guard?: ReturnType<typeof createAccountGuard>): Request {
  return {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    app: { locals: guard ? { accountGuard: guard } : {} },
  } as unknown as Request;
}

test("a session stops working the moment its account is disabled", async () => {
  const { accounts, ada } = await twoSas();
  const guard = createAccountGuard(accounts);
  const config = { sessionSecret: SECRET } as AppConfig;
  const token = await signSession({ sub: ada.id, clientId: "mcpencode-web", role: "sa", csrf: "c" }, SECRET);

  const before = await sessionAccess(requestWithSession(token, guard), config);
  assert.equal(before?.sub, ada.id);
  assert.equal(before?.role, "sa");

  await accounts.setDisabled(ada.id, true);
  assert.equal(await sessionAccess(requestWithSession(token, guard), config), undefined);
});

test("a session takes the account's current role, not the one in the cookie", async () => {
  const { accounts, ada } = await twoSas();
  const guard = createAccountGuard(accounts);
  const config = { sessionSecret: SECRET } as AppConfig;
  const token = await signSession({ sub: ada.id, clientId: "mcpencode-web", role: "sa", csrf: "c" }, SECRET);
  await accounts.setSa(ada.id, false);
  const access = await sessionAccess(requestWithSession(token, guard), config);
  assert.equal(access?.role, "readonly");
  assert.equal(access?.permissions.includes("accounts.manage"), false);
});

test("a sign-in in the same second as a sign-out still counts as after it", async () => {
  const { accounts, ada } = await twoSas();
  const guard = createAccountGuard(accounts);
  const config = { sessionSecret: SECRET } as AppConfig;
  const before = await signSession({ sub: ada.id, clientId: "mcpencode-web", role: "sa", csrf: "c" }, SECRET);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await accounts.revokeSessions(ada.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = await signSession({ sub: ada.id, clientId: "mcpencode-web", role: "sa", csrf: "c" }, SECRET);
  // Whole-second iat would put both in the same second; the guard must still tell them apart.
  assert.equal(await sessionAccess(requestWithSession(before, guard), config), undefined);
  assert.ok(await sessionAccess(requestWithSession(after, guard), config));
});

test("without a guard (external identity provider) the session is read as before", async () => {
  const config = { sessionSecret: SECRET } as AppConfig;
  const token = await signSession({ sub: "idp-user", clientId: "web", role: "readonly", csrf: "c" }, SECRET);
  const access = await sessionAccess(requestWithSession(token), config);
  assert.equal(access?.sub, "idp-user");
  assert.equal(access?.role, "readonly");
});

async function startIdp(accounts: ReturnType<typeof memoryAccountStore>) {
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mcpencode-web",
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  mcpClientId = await registeredClientId(base, ["http://127.0.0.1:8765/callback"]);
  return { base, close: () => server.close() };
}

type Tokens = { refresh_token: string; scope: string };

async function signIn(base: string, username: string): Promise<Tokens> {
  const verifier = "v".repeat(64);
  const redirectUri = "http://127.0.0.1:8765/callback";
  const code = await signInForCode(
    base,
    {
      client_id: mcpClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "s",
    },
    username,
    PASSWORD,
  );
  const token = await fetch(`${base}/id/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: mcpClientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  assert.equal(token.status, 200);
  return (await token.json()) as Tokens;
}

function refresh(base: string, refreshToken: string) {
  return fetch(`${base}/id/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: mcpClientId,
    }),
  });
}

test("a refresh token stops working when its account is disabled", async () => {
  const { accounts, ada } = await twoSas();
  const idp = await startIdp(accounts);
  try {
    const tokens = await signIn(idp.base, "ada");
    const first = await refresh(idp.base, tokens.refresh_token);
    assert.equal(first.status, 200);
    const next = ((await first.json()) as Tokens).refresh_token;

    await accounts.setDisabled(ada.id, true);
    const denied = await refresh(idp.base, next);
    assert.equal(denied.status, 400);
    assert.deepEqual(await denied.json(), { error: "invalid_grant" });
  } finally {
    idp.close();
  }
});

test("a refreshed token carries the account's current role", async () => {
  const { accounts, ada } = await twoSas();
  const idp = await startIdp(accounts);
  try {
    const tokens = await signIn(idp.base, "ada");
    assert.match(tokens.scope, /mcpencode:sa/);
    await accounts.setSa(ada.id, false);
    const renewed = await refresh(idp.base, tokens.refresh_token);
    assert.equal(renewed.status, 200);
    const body = (await renewed.json()) as Tokens;
    assert.equal(body.scope, "openid mcpencode:readonly");
  } finally {
    idp.close();
  }
});

function saToken(sub: string): AuthInfo {
  return {
    token: "test",
    clientId: "test-client",
    scopes: ["openid", "mcpencode:edit", "mcpencode:sa"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { sub, role: "sa" },
  };
}

test("an MCP token stops working when its account is disabled", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "HR", "alice", "general");
    const { accounts, ada } = await twoSas();
    const guard = createAccountGuard(accounts);

    const open = await resolveLibraryMcpAccess(db, saToken(ada.id), library.id, guard);
    assert.ok(!("error" in open));

    await accounts.setDisabled(ada.id, true);
    const denied = await resolveLibraryMcpAccess(db, saToken(ada.id), library.id, guard);
    assert.deepEqual(denied, { error: ACCOUNT_UNAVAILABLE });
  });
});

test("an MCP token from a demoted SA no longer opens every library", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "HR", "alice", "general");
    const { accounts, ada } = await twoSas();
    const guard = createAccountGuard(accounts);
    await accounts.setSa(ada.id, false);
    // The token still says SA. The account no longer is.
    const denied = await resolveLibraryMcpAccess(db, saToken(ada.id), library.id, guard);
    assert.deepEqual(denied, { error: FORBIDDEN_LIBRARY });
  });
});

test("without a guard the MCP check is unchanged", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "HR", "alice", "general");
    const open = await resolveLibraryMcpAccess(db, saToken("anyone"), library.id);
    assert.ok(!("error" in open));
  });
});
