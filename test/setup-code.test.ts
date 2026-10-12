import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WEB_OAUTH } from "./oauth-flow.ts";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { newSetupCode, setupCodeMatches } from "../src/auth/setup-code.ts";
import { isPublicDeployment, type AppConfig } from "../src/config.ts";

test("setup codes are random and long enough to guess-proof", () => {
  const a = newSetupCode();
  const b = newSetupCode();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("a setup code must match exactly, and pasted whitespace is forgiven", () => {
  assert.equal(setupCodeMatches("correct-code-123456", "correct-code-123456"), true);
  assert.equal(setupCodeMatches("  correct-code-123456\n", "correct-code-123456"), true);
  assert.equal(setupCodeMatches("correct-code-12345", "correct-code-123456"), false);
  assert.equal(setupCodeMatches("", "correct-code-123456"), false);
});

test("only a loopback bind with a loopback address counts as local", () => {
  assert.equal(isPublicDeployment("127.0.0.1", "http://127.0.0.1:3000"), false);
  assert.equal(isPublicDeployment("127.0.0.1", "http://localhost:3000"), false);
  assert.equal(isPublicDeployment("::1", "http://[::1]:3000"), false);
  // A bind on every interface is reachable by others.
  assert.equal(isPublicDeployment("0.0.0.0", "http://127.0.0.1:3000"), true);
  // A reverse proxy on loopback that serves a public domain is still public.
  assert.equal(isPublicDeployment("127.0.0.1", "https://library.example.org"), true);
});

const TOKEN = "operator-chosen-setup-token";
const PASSWORD = "correct horse battery";

async function startIdp(overrides: Partial<AppConfig>) {
  const accounts = memoryAccountStore();
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mpos-web",
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { accounts, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const oauth = WEB_OAUTH;

function createAccount(base: string, extra: Record<string, string>) {
  return fetch(`${base}/id/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...oauth,
      setup: "1",
      username: "ada",
      password: PASSWORD,
      password_confirm: PASSWORD,
      ...extra,
    }),
    redirect: "manual",
  });
}

test("on a public deployment the first-account form asks for a setup code", async () => {
  const idp = await startIdp({ setupCodeRequired: true, setupToken: TOKEN });
  try {
    const page = await fetch(`${idp.base}/id/authorize?${new URLSearchParams(oauth)}`);
    const html = await page.text();
    assert.match(html, /name="setup_code"/);
    assert.match(html, /Create account/);
  } finally {
    idp.close();
  }
});

test("no account is created without the right setup code", async () => {
  const idp = await startIdp({ setupCodeRequired: true, setupToken: TOKEN });
  try {
    const missing = await createAccount(idp.base, {});
    assert.equal(missing.status, 200);
    assert.match(await missing.text(), /setup code is not correct/);

    const wrong = await createAccount(idp.base, { setup_code: "not-the-operator-code" });
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /setup code is not correct/);

    assert.equal(await idp.accounts.count(), 0);
  } finally {
    idp.close();
  }
});

test("the right setup code creates the first account", async () => {
  const idp = await startIdp({ setupCodeRequired: true, setupToken: TOKEN });
  try {
    const created = await createAccount(idp.base, { setup_code: TOKEN });
    assert.equal(created.status, 302);
    assert.equal(await idp.accounts.count(), 1);
  } finally {
    idp.close();
  }
});

test("wrong setup codes count toward the sign-in wait", async () => {
  const idp = await startIdp({ setupCodeRequired: true, setupToken: TOKEN });
  try {
    for (let i = 0; i < 5; i += 1) await createAccount(idp.base, { setup_code: `guess-${i}` });
    // Now blocked, even with the right code.
    const blocked = await createAccount(idp.base, { setup_code: TOKEN });
    assert.equal(blocked.status, 200);
    assert.match(await blocked.text(), /Too many sign-in attempts/);
    assert.equal(await idp.accounts.count(), 0);
  } finally {
    idp.close();
  }
});

test("on a local-only instance the first account needs no setup code", async () => {
  const idp = await startIdp({});
  try {
    const page = await fetch(`${idp.base}/id/authorize?${new URLSearchParams(oauth)}`);
    assert.doesNotMatch(await page.text(), /name="setup_code"/);
    const created = await createAccount(idp.base, {});
    assert.equal(created.status, 302);
    assert.equal(await idp.accounts.count(), 1);
  } finally {
    idp.close();
  }
});
