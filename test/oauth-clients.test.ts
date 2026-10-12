import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { createAccountGuard } from "../src/auth/account-guard.ts";
import { memoryAccountStore, type AccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp, LEGACY_CLIENT_ID } from "../src/auth/embedded-idp.ts";
import { memoryIdpStore, type IdpStore } from "../src/auth/idp-store.ts";
import type { AppConfig } from "../src/config.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import { answerConsent, readConsent, registerClient, signInForCode } from "./oauth-flow.ts";

const PASSWORD = "correct horse battery";
const LIBRARY_ID = "00000000-0000-4000-8000-000000000001";
const LIBRARY_RESOURCE = `http://127.0.0.1:3000/libraries/${LIBRARY_ID}/mcp/${"t".repeat(43)}`;
const CALLBACK = "http://127.0.0.1:33418/callback";
const VERIFIER = "v".repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

async function startIdp(
  overrides: Partial<AppConfig> = {},
  input: { store?: IdpStore; accounts?: AccountStore } = {},
) {
  const accounts = input.accounts ?? memoryAccountStore();
  if ((await accounts.count()) === 0) {
    const created = await accounts.create({ username: "ada", password: PASSWORD, role: "sa" });
    assert.ok(created.ok);
  }
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mpos-web",
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts, {
    store: input.store,
    libraryName: async (id) => (id === LIBRARY_ID ? "Runbooks" : undefined),
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    idp,
    accounts,
    config,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function register(base: string, uris = [CALLBACK], name = "Claude Code (runbooks)") {
  const res = await registerClient(base, uris, name);
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; redirect_uris: string[]; client_name?: string };
}

async function authorizeParams(clientId: string, redirectUri = CALLBACK) {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    resource: LIBRARY_RESOURCE,
    state: "st",
  };
}

type TokenBody = { access_token?: string; refresh_token?: string; error?: string; error_description?: string };

async function exchange(base: string, body: Record<string, string>): Promise<{ status: number; json: TokenBody }> {
  const res = await fetch(`${base}/id/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as TokenBody };
}

async function fullSignIn(base: string, clientId: string, redirectUri = CALLBACK) {
  const code = await signInForCode(base, await authorizeParams(clientId, redirectUri), "ada", PASSWORD);
  const tokens = await exchange(base, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: VERIFIER,
  });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
  return tokens.json as Required<Pick<TokenBody, "access_token" | "refresh_token">>;
}

function refresh(base: string, clientId: string, token: string) {
  return exchange(base, { grant_type: "refresh_token", refresh_token: token, client_id: clientId });
}

test("registration stores a random client id tied to its callbacks", async () => {
  const s = await startIdp();
  try {
    const one = await register(s.base);
    const two = await register(s.base);
    assert.match(one.client_id, /^mcp_[A-Za-z0-9_-]{20,}$/);
    assert.notEqual(one.client_id, LEGACY_CLIENT_ID);
    assert.notEqual(one.client_id, two.client_id);
    assert.deepEqual(one.redirect_uris, [CALLBACK]);
    assert.equal(one.client_name, "Claude Code (runbooks)");

    // Only a registered callback is accepted for that client.
    const page = (clientId: string, uri: string) =>
      fetch(`${s.base}/id/authorize?${new URLSearchParams({ ...mcpBase, client_id: clientId, redirect_uri: uri })}`);
    assert.equal((await page(one.client_id, CALLBACK)).status, 200);
    assert.equal((await page(one.client_id, "http://127.0.0.1:50000/callback")).status, 200);
    assert.equal((await page(one.client_id, "http://127.0.0.1:33418/other")).status, 400);
    assert.equal((await page(one.client_id, "cursor://anysphere.cursor-mcp/oauth/callback")).status, 400);
    assert.equal((await page("mcp_not-registered-anywhere", CALLBACK)).status, 400);
  } finally {
    await s.close();
  }
});

const mcpBase = {
  response_type: "code",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
};

test("a remote https callback needs OAUTH_REDIRECT_HOSTS or the any-https opt-in", async () => {
  const strict = await startIdp();
  try {
    assert.equal((await registerClient(strict.base, ["https://evil.example/cb"])).status, 400);
    const authorize = await fetch(
      `${strict.base}/id/authorize?${new URLSearchParams({ ...mcpBase, client_id: LEGACY_CLIENT_ID, redirect_uri: "https://evil.example/cb" })}`,
    );
    assert.equal(authorize.status, 400);
  } finally {
    await strict.close();
  }
  const listed = await startIdp({ oauthRedirectHosts: ["claude.ai"] });
  try {
    assert.equal((await registerClient(listed.base, ["https://claude.ai/api/mcp/auth_callback"])).status, 201);
    assert.equal((await registerClient(listed.base, ["https://evil.example/cb"])).status, 400);
  } finally {
    await listed.close();
  }
  const open = await startIdp({ oauthAllowAnyHttpsRedirect: true });
  try {
    const client = await register(open.base, ["https://anything.example/cb"]);
    assert.equal(
      (
        await fetch(
          `${open.base}/id/authorize?${new URLSearchParams({ ...mcpBase, client_id: client.client_id, redirect_uri: "https://anything.example/cb" })}`,
        )
      ).status,
      200,
    );
    // The legacy id never gets the any-https opt-in.
    assert.equal(
      (
        await fetch(
          `${open.base}/id/authorize?${new URLSearchParams({ ...mcpBase, client_id: LEGACY_CLIENT_ID, redirect_uri: "https://anything.example/cb" })}`,
        )
      ).status,
      400,
    );
  } finally {
    await open.close();
  }
});

test("registration refuses confidential clients and unknown grants", async () => {
  const s = await startIdp();
  try {
    const post = (body: unknown) =>
      fetch(`${s.base}/id/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_basic" })).status, 400);
    assert.equal((await post({ redirect_uris: [CALLBACK], grant_types: ["implicit"] })).status, 400);
    assert.equal((await post({ redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${1000 + i}/cb`) })).status, 400);
  } finally {
    await s.close();
  }
});

test("a loopback client registers, consents and completes PKCE end to end", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const authorize = await fetch(`${s.base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...(await authorizeParams(client.client_id)), username: "ada", password: PASSWORD }),
      redirect: "manual",
    });
    // No code before consent.
    assert.equal(authorize.headers.get("location"), null);
    const consent = await readConsent(authorize);
    assert.match(consent.html, /Claude Code \(runbooks\)/);
    assert.match(consent.html, /127\.0\.0\.1:33418/);
    assert.match(consent.html, /Runbooks/);
    assert.match(consent.html, /<strong>ada<\/strong>/);
    assert.match(consent.html, new RegExp(client.client_id));

    const allowed = await answerConsent(s.base, consent);
    assert.equal(allowed.status, 302);
    const next = new URL(allowed.headers.get("location") ?? "");
    assert.equal(`${next.origin}${next.pathname}`, CALLBACK);
    assert.equal(next.searchParams.get("state"), "st");
    const code = next.searchParams.get("code") ?? "";

    // The token endpoint checks client_id, redirect_uri and PKCE.
    const base = { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: VERIFIER };
    const tokens = await exchange(s.base, base);
    assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
    const { payload } = await jwtVerify(tokens.json.access_token ?? "", s.idp.publicKey, {
      issuer: s.config.authIssuer,
      audience: LIBRARY_RESOURCE,
    });
    assert.equal(payload.azp, client.client_id);
    // A code is single-use.
    assert.equal((await exchange(s.base, base)).status, 400);
  } finally {
    await s.close();
  }
});

test("the token endpoint refuses a code for another client or callback", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const other = await register(s.base);
    for (const change of [
      { client_id: other.client_id },
      { client_id: "" },
      { redirect_uri: "http://127.0.0.1:50000/callback" },
      { code_verifier: "w".repeat(64) },
    ]) {
      const code = await signInForCode(s.base, await authorizeParams(client.client_id), "ada", PASSWORD);
      const res = await exchange(s.base, {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
        ...change,
      });
      assert.equal(res.status, 400, JSON.stringify(change));
      assert.equal(res.json.error, "invalid_grant");
    }
  } finally {
    await s.close();
  }
});

test("Deny sends the client an access_denied error and no code", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const authorize = await fetch(`${s.base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...(await authorizeParams(client.client_id)), username: "ada", password: PASSWORD }),
      redirect: "manual",
    });
    const denied = await answerConsent(s.base, await readConsent(authorize), "deny");
    assert.equal(denied.status, 302);
    const next = new URL(denied.headers.get("location") ?? "");
    assert.equal(next.searchParams.get("error"), "access_denied");
    assert.equal(next.searchParams.get("code"), null);
  } finally {
    await s.close();
  }
});

test("consent needs the cookie from the page that showed it, once", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const show = async () =>
      readConsent(
        await fetch(`${s.base}/id/authorize`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...(await authorizeParams(client.client_id)), username: "ada", password: PASSWORD }),
          redirect: "manual",
        }),
      );
    const first = await show();
    // A cross-site form post has no cookie: refused, and the consent is spent.
    const forged = await answerConsent(s.base, { ...first, cookie: "" });
    assert.equal(forged.status, 400);
    assert.equal((await answerConsent(s.base, first)).status, 400);

    const second = await show();
    const other = await show();
    assert.equal((await answerConsent(s.base, { ...second, cookie: other.cookie })).status, 400);
    const ok = await answerConsent(s.base, other);
    assert.equal(ok.status, 302);
    assert.equal((await answerConsent(s.base, other)).status, 400);
  } finally {
    await s.close();
  }
});

test("the publisher's own sign-in skips consent", async () => {
  const s = await startIdp();
  try {
    const res = await fetch(`${s.base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...mcpBase,
        client_id: "mpos-web",
        redirect_uri: "http://127.0.0.1:3000/callback",
        username: "ada",
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(new URL(res.headers.get("location") ?? "").searchParams.get("code"));
  } finally {
    await s.close();
  }
});

test("the legacy mpos-mcp id keeps loopback and app-scheme callbacks working, with consent", async () => {
  const s = await startIdp();
  try {
    for (const uri of [CALLBACK, "http://localhost:6274/oauth/callback", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      const authorize = await fetch(`${s.base}/id/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...(await authorizeParams(LEGACY_CLIENT_ID, uri)), username: "ada", password: PASSWORD }),
        redirect: "manual",
      });
      const consent = await readConsent(authorize);
      assert.match(consent.html, /shared id will be retired/);
    }
    const tokens = await fullSignIn(s.base, LEGACY_CLIENT_ID);
    assert.ok(tokens.refresh_token);
  } finally {
    await s.close();
  }
  const off = await startIdp({ oauthLegacyClient: false });
  try {
    const page = await fetch(
      `${off.base}/id/authorize?${new URLSearchParams({ ...mcpBase, client_id: LEGACY_CLIENT_ID, redirect_uri: CALLBACK })}`,
    );
    assert.equal(page.status, 400);
  } finally {
    await off.close();
  }
});

test("refresh rotates, and a reused refresh token revokes the whole chain", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const first = await fullSignIn(s.base, client.client_id);
    const second = await refresh(s.base, client.client_id, first.refresh_token);
    assert.equal(second.status, 200);
    assert.notEqual(second.json.refresh_token, first.refresh_token);

    // The first token was already rotated. Presenting it again is reuse.
    const reused = await refresh(s.base, client.client_id, first.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.json.error, "invalid_grant");
    // The newest token in that chain is gone too.
    assert.equal((await refresh(s.base, client.client_id, second.json.refresh_token ?? "")).status, 400);

    // Another sign-in is a separate chain and is not touched.
    const other = await fullSignIn(s.base, client.client_id);
    assert.equal((await refresh(s.base, client.client_id, other.refresh_token)).status, 200);
  } finally {
    await s.close();
  }
});

test("a refresh token is bound to its client", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const other = await register(s.base);
    const tokens = await fullSignIn(s.base, client.client_id);
    assert.equal((await refresh(s.base, other.client_id, tokens.refresh_token)).status, 400);
    // The attempt burned the chain.
    assert.equal((await refresh(s.base, client.client_id, tokens.refresh_token)).status, 400);
  } finally {
    await s.close();
  }
});

test("a refresh chain ends at its maximum lifetime", async () => {
  const base = memoryIdpStore();
  // Pretend this sign-in happened 31 days ago, with an idle expiry still in the future.
  const aged: IdpStore = {
    ...base,
    insertRefresh: (record) =>
      base.insertRefresh({ ...record, chainStartedAt: record.chainStartedAt - 31 * DAY_MS, expiresAt: Date.now() + DAY_MS }),
  };
  const s = await startIdp({ refreshMaxLifetimeDays: 30 }, { store: aged });
  try {
    const client = await register(s.base);
    const tokens = await fullSignIn(s.base, client.client_id);
    assert.equal((await refresh(s.base, client.client_id, tokens.refresh_token)).status, 400);
  } finally {
    await s.close();
  }
  const longer = await startIdp({ refreshMaxLifetimeDays: 60 }, { store: aged });
  try {
    const client = await register(longer.base);
    const tokens = await fullSignIn(longer.base, client.client_id);
    assert.equal((await refresh(longer.base, client.client_id, tokens.refresh_token)).status, 200);
  } finally {
    await longer.close();
  }
});

test("a new refresh token never outlives the chain", async () => {
  const store = memoryIdpStore();
  const seen: number[] = [];
  const spy: IdpStore = {
    ...store,
    insertRefresh: async (record) => {
      seen.push(record.expiresAt - record.chainStartedAt);
      return store.insertRefresh(record);
    },
  };
  const s = await startIdp({ refreshMaxLifetimeDays: 1 }, { store: spy });
  try {
    const client = await register(s.base);
    await fullSignIn(s.base, client.client_id);
    assert.ok(seen.every((ms) => ms <= DAY_MS));
  } finally {
    await s.close();
  }
});

test("signing out everywhere rejects the old refresh token and access token", async () => {
  const s = await startIdp();
  try {
    const client = await register(s.base);
    const tokens = await fullSignIn(s.base, client.client_id);
    const ada = await s.accounts.findByUsername("ada");
    assert.ok(ada);
    const guard = createAccountGuard(s.accounts);
    const { payload } = await jwtVerify(tokens.access_token, s.idp.publicKey);
    assert.deepEqual(await guard(ada.id, payload.iat), { allowed: true, role: "sa" });

    await s.idp.revokeAccount(ada.id);
    const denied = await refresh(s.base, client.client_id, tokens.refresh_token);
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error, "invalid_grant");
    // The 15-minute access token is refused at once too.
    assert.deepEqual(await guard(ada.id, payload.iat), { allowed: false });
    assert.deepEqual(await guard(ada.id, undefined), { allowed: false });
    // A sign-in after that works.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await fullSignIn(s.base, client.client_id);
    const fresh = await jwtVerify(again.access_token, s.idp.publicKey);
    assert.deepEqual(await guard(ada.id, fresh.payload.iat), { allowed: true, role: "sa" });
  } finally {
    await s.close();
  }
});

test("the signing key is kept in the store with a real key id, so a restart keeps tokens valid", async () => {
  const store = memoryIdpStore();
  const accounts = memoryAccountStore();
  const first = await startIdp({}, { store, accounts });
  let accessToken: string;
  let kid: string;
  try {
    const client = await register(first.base);
    accessToken = (await fullSignIn(first.base, client.client_id)).access_token;
    kid = first.idp.kid;
    assert.notEqual(kid, "mpos-dev");
    assert.equal(decodeProtectedHeader(accessToken).kid, kid);
    const jwks = (await (await fetch(`${first.base}/id/jwks`)).json()) as { keys: { kid: string; d?: string }[] };
    assert.deepEqual(
      jwks.keys.map((key) => key.kid),
      [kid],
    );
    assert.equal(jwks.keys[0]?.d, undefined);
  } finally {
    await first.close();
  }
  // "Restart": a new IdP on the same store.
  const second = await startIdp({}, { store, accounts });
  try {
    assert.equal(second.idp.kid, kid);
    const verified = await jwtVerify(accessToken, second.idp.publicKey, { audience: LIBRARY_RESOURCE });
    assert.equal(verified.protectedHeader.kid, kid);
  } finally {
    await second.close();
  }
});
