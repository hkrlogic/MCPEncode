/**
 * v0.1 release blockers: browser-launcher callbacks, registration and
 * authorize limits, consent page wording, and the sign-in throttle.
 */
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp, LEGACY_CLIENT_ID } from "../src/auth/embedded-idp.ts";
import { memoryIdpStore } from "../src/auth/idp-store.ts";
import { callbackKind, isLauncherScheme, parseAllowedSchemes } from "../src/auth/redirect.ts";
import { addressKey, MAX_ENTRIES, SignInLimit } from "../src/auth/signin-limit.ts";
import type { AppConfig } from "../src/config.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import { answerConsent, readConsent, registerClient } from "./oauth-flow.ts";

const PASSWORD = "correct horse battery";
const VERIFIER = "v".repeat(64);

/** Every one of these opens a browser or OS handler at an address of the client's choosing. */
const LAUNCHER_CALLBACKS = [
  "microsoft-edge:https://evil.example/cb",
  "microsoft-edge:http://evil.example/cb",
  "x-safari-https://evil.example/cb",
  "x-safari-http://evil.example/cb",
  "googlechrome://evil.example/cb",
  "googlechromes://evil.example/cb",
  "firefox:https://evil.example/cb",
  "firefox://open-url?url=https://evil.example/cb",
  "opera:https://evil.example/cb",
  "brave://evil.example/cb",
  "ms-word:ofe|u|https://evil.example/cb",
  "search-ms:query=x&crumb=location:\\\\evil.example\\share",
  "shell:startup",
  "file:///etc/passwd",
  "data:text/html,hi",
  "javascript:alert(1)",
  "vbscript:msgbox(1)",
  // Unknown single-word scheme: not reverse-DNS, not on the allowlist.
  "evilapp://cb",
  // A dotted scheme that carries another URL in its path.
  "com.example.app:https://evil.example/cb",
  "com.example.app:https%3A%2F%2Fevil.example%2Fcb",
];

const LEGIT_CALLBACKS = [
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "vscode://vscode.github-authentication/did-authenticate",
  "vscode-insiders://vscode.github-authentication/did-authenticate",
  "claude://claude.ai/oauth/callback",
  "com.example.app:/oauth2redirect",
  "http://127.0.0.1:33418/callback",
  "http://localhost:6274/oauth/callback",
  "http://[::1]:9000/callback",
];

test("browser-launcher, OS-handler and smuggled-URL callbacks are refused", () => {
  for (const uri of LAUNCHER_CALLBACKS) assert.equal(callbackKind(uri, {}), undefined, uri);
  for (const uri of LEGIT_CALLBACKS) assert.notEqual(callbackKind(uri, {}), undefined, uri);
  assert.equal(isLauncherScheme("MICROSOFT-EDGE"), true);
  assert.equal(isLauncherScheme("ms-settings"), true);
  assert.equal(isLauncherScheme("cursor"), false);
});

test("OAUTH_ALLOWED_SCHEMES adds single-word app schemes but never a launcher", () => {
  assert.equal(callbackKind("windsurf://cb/oauth", {}), undefined);
  const allowedSchemes = parseAllowedSchemes("windsurf");
  assert.equal(callbackKind("windsurf://cb/oauth", { allowedSchemes }), "custom-scheme");
  assert.equal(callbackKind("cursor://anysphere.cursor-mcp/oauth/callback", { allowedSchemes }), "custom-scheme");
  assert.throws(() => parseAllowedSchemes("microsoft-edge"), /OAUTH_ALLOWED_SCHEMES/);
  assert.throws(() => parseAllowedSchemes("x-safari-https"), /OAUTH_ALLOWED_SCHEMES/);
  assert.throws(() => parseAllowedSchemes("firefox"), /OAUTH_ALLOWED_SCHEMES/);
});

async function startIdp(overrides: Partial<AppConfig> = {}) {
  const accounts = memoryAccountStore();
  assert.ok((await accounts.create({ username: "ada", password: PASSWORD, role: "sa" })).ok);
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mpos-web",
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts, { store: memoryIdpStore() });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function authorizeParams(clientId: string, redirectUri: string) {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "st",
  };
}

test("register and authorize refuse launcher callbacks for registered and legacy clients", async () => {
  const s = await startIdp();
  try {
    for (const uri of LAUNCHER_CALLBACKS) {
      const res = await registerClient(s.base, [uri]);
      assert.equal(res.status, 400, uri);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_redirect_uri");
      const page = await fetch(`${s.base}/id/authorize?${new URLSearchParams(await authorizeParams(LEGACY_CLIENT_ID, uri))}`);
      assert.equal(page.status, 400, uri);
    }
    // The shared legacy id never takes a reverse-DNS scheme: anyone can claim one.
    const dotted = await fetch(
      `${s.base}/id/authorize?${new URLSearchParams(await authorizeParams(LEGACY_CLIENT_ID, "com.example.app:/cb"))}`,
    );
    assert.equal(dotted.status, 400);
    // ...but Cursor and loopback keep working on it.
    for (const uri of ["cursor://anysphere.cursor-mcp/oauth/callback", "http://127.0.0.1:33418/callback"]) {
      const ok = await fetch(`${s.base}/id/authorize?${new URLSearchParams(await authorizeParams(LEGACY_CLIENT_ID, uri))}`);
      assert.equal(ok.status, 200, uri);
    }
  } finally {
    await s.close();
  }
});

test("a cursor:// client completes PKCE and consent; the page shows the full callback and an unverified name", async () => {
  const s = await startIdp();
  const callback = "cursor://anysphere.cursor-mcp/oauth/callback?x=1";
  try {
    const reg = await registerClient(s.base, [callback], "Cursor");
    assert.equal(reg.status, 201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const params = await authorizeParams(client_id, callback);
    const login = await fetch(`${s.base}/id/authorize?${new URLSearchParams(params)}`);
    assert.match(await login.text(), /cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback\?x=1/);
    const authorize = await fetch(`${s.base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, username: "ada", password: PASSWORD }),
      redirect: "manual",
    });
    const consent = await readConsent(authorize);
    assert.match(consent.html, /says it is <strong>Cursor<\/strong> \(unverified/);
    assert.match(consent.html, /cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback\?x=1/);
    const allowed = await answerConsent(s.base, consent);
    assert.equal(allowed.status, 302);
    const next = new URL(allowed.headers.get("location") ?? "");
    assert.equal(next.protocol, "cursor:");
    const tokens = await fetch(`${s.base}/id/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: next.searchParams.get("code") ?? "",
        client_id,
        redirect_uri: callback,
        code_verifier: VERIFIER,
      }),
    });
    assert.equal(tokens.status, 200);
  } finally {
    await s.close();
  }
});

test("a burst of registrations from one address gets 429", async () => {
  const s = await startIdp({ oauthRegisterRateLimit: 3 });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await registerClient(s.base, ["http://127.0.0.1:1/cb"])).status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  } finally {
    await s.close();
  }
});

test("pending registrations are capped by OAUTH_MAX_PENDING_CLIENTS", async () => {
  const s = await startIdp({ oauthRegisterRateLimit: 0, oauthMaxPendingClients: 2 });
  try {
    assert.equal((await registerClient(s.base, ["http://127.0.0.1:1/cb"])).status, 201);
    assert.equal((await registerClient(s.base, ["http://127.0.0.1:1/cb"])).status, 201);
    const full = await registerClient(s.base, ["http://127.0.0.1:1/cb"]);
    assert.equal(full.status, 503);
    assert.equal(((await full.json()) as { error: string }).error, "temporarily_unavailable");
  } finally {
    await s.close();
  }
});

test("registration takes at most 8 callbacks and 8 KB", async () => {
  const s = await startIdp({ oauthRegisterRateLimit: 0 });
  try {
    const nine = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${1000 + i}/cb`);
    assert.equal((await registerClient(s.base, nine)).status, 400);
    const big = await registerClient(s.base, ["http://127.0.0.1:1/cb"], "x".repeat(9000));
    assert.equal(big.status, 413);
  } finally {
    await s.close();
  }
});

test("authorize is rate limited per address", async () => {
  const s = await startIdp({ oauthAuthorizeRateLimit: 2 });
  try {
    const url = `${s.base}/id/authorize?${new URLSearchParams(await authorizeParams(LEGACY_CLIENT_ID, "http://127.0.0.1:1/cb"))}`;
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await fetch(url)).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await s.close();
  }
});

test("sign-in throttle counts IPv6 per /64", () => {
  assert.equal(addressKey("2001:db8:1:2:aaaa::1"), addressKey("2001:db8:1:2:bbbb::2"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.equal(addressKey("::ffff:203.0.113.5"), "203.0.113.5");
  const limit = new SignInLimit({ pairAllowance: 3, now: () => 1_000 });
  for (let i = 0; i < 3; i += 1) assert.equal(limit.begin("ada", `2001:db8:1:2::${i + 1}`), true);
  // A fresh address in the same /64 is the same counter.
  assert.equal(limit.begin("ada", "2001:db8:1:2::ffff"), false);
});

test("a known-good address gets past the username-wide throttle", () => {
  let now = 1_000;
  const limit = new SignInLimit({ now: () => now, usernameAllowance: 5 });
  assert.equal(limit.begin("sa", "198.51.100.1"), true);
  limit.succeed("sa", "198.51.100.1");
  // A distributed guess from many addresses fills the username counter.
  for (let i = 0; i < 10; i += 1) limit.begin("sa", `203.0.113.${i}`);
  now += 10;
  assert.equal(limit.blocked("sa", "192.0.2.77"), true);
  // The SA's usual address is not held up.
  assert.equal(limit.begin("sa", "198.51.100.1"), true);
});

test("throttle maps stay bounded", () => {
  let now = 1_000;
  const limit = new SignInLimit({ now: () => now });
  for (let i = 0; i < MAX_ENTRIES + 500; i += 1) {
    now += 1;
    limit.begin(`user${i}`, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  }
  const size = limit.size();
  assert.ok(size.pairs <= MAX_ENTRIES && size.addresses <= MAX_ENTRIES && size.usernames <= MAX_ENTRIES, JSON.stringify(size));
});
