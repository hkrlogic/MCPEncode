import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { isAllowedCallback } from "../src/auth/redirect.ts";
import type { AppConfig } from "../src/config.ts";

const base = {
  clientId: "mpos-mcp",
  webClientId: "mpos-web",
  publicBaseUrl: "http://127.0.0.1:3000",
};

test("with no allowlist set, any remote callback is accepted as before", () => {
  assert.equal(isAllowedCallback("https://anything.example/cb", base), true);
  assert.equal(isAllowedCallback("https://anything.example/cb", { ...base, allowedHosts: [] }), true);
});

test("with an allowlist, remote web callbacks must be on it", () => {
  const check = { ...base, allowedHosts: ["claude.ai", "www.perplexity.ai"] };
  assert.equal(isAllowedCallback("https://claude.ai/api/mcp/auth_callback", check), true);
  assert.equal(isAllowedCallback("https://www.perplexity.ai/oauth", check), true);
  assert.equal(isAllowedCallback("https://evil.example/cb", check), false);
  // A lookalike or subdomain is not on the list.
  assert.equal(isAllowedCallback("https://claude.ai.evil.example/cb", check), false);
  assert.equal(isAllowedCallback("https://sub.claude.ai/cb", check), false);
});

test("an allowlist leaves desktop loopback and app-scheme callbacks alone", () => {
  const check = { ...base, allowedHosts: ["claude.ai"] };
  assert.equal(isAllowedCallback("http://localhost:8787/callback", check), true);
  assert.equal(isAllowedCallback("http://127.0.0.1:8765/oauth/callback", check), true);
  assert.equal(isAllowedCallback("http://[::1]:9000/callback", check), true);
  assert.equal(isAllowedCallback("cursor://anysphere.cursor-mcp/oauth/callback", check), true);
});

test("an allowlist never loosens the rules that already reject a callback", () => {
  const check = { ...base, allowedHosts: ["evil.example"] };
  assert.equal(isAllowedCallback("javascript:alert(1)", check), false);
  assert.equal(isAllowedCallback("https://user:pass@evil.example/cb", check), false);
});

const LIBRARY_RESOURCE = `http://127.0.0.1:3000/libraries/00000000-0000-4000-8000-000000000001/mcp/${"t".repeat(43)}`;
const PASSWORD = "correct horse battery";

async function startIdp(overrides: Partial<AppConfig> = {}) {
  const accounts = memoryAccountStore();
  const created = await accounts.create({ username: "ada", password: PASSWORD, role: "sa" });
  assert.ok(created.ok);
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
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const mcpParams = {
  client_id: "mpos-mcp",
  redirect_uri: "https://client.example/oauth/callback",
  response_type: "code",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
};

test("the sign-in page says where the person will be sent", async () => {
  const idp = await startIdp();
  try {
    const page = await fetch(`${idp.base}/id/authorize?${new URLSearchParams(mcpParams)}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /you will be sent to <strong>https:\/\/client\.example\/oauth\/callback<\/strong>/);
    assert.match(html, /Continue only if you started this from an app you trust/);
  } finally {
    idp.close();
  }
});

test("the publisher's own sign-in does not show a destination", async () => {
  const idp = await startIdp();
  try {
    const params = {
      ...mcpParams,
      client_id: "mpos-web",
      redirect_uri: "http://127.0.0.1:3000/callback",
    };
    const page = await fetch(`${idp.base}/id/authorize?${new URLSearchParams(params)}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /you will be sent to/);
  } finally {
    idp.close();
  }
});

test("an operator allowlist turns away an unlisted callback at the sign-in page", async () => {
  const idp = await startIdp({ oauthRedirectHosts: ["claude.ai"] });
  try {
    const listed = await fetch(
      `${idp.base}/id/authorize?${new URLSearchParams({ ...mcpParams, redirect_uri: "https://claude.ai/cb" })}`,
    );
    assert.equal(listed.status, 200);
    const unlisted = await fetch(`${idp.base}/id/authorize?${new URLSearchParams(mcpParams)}`);
    assert.equal(unlisted.status, 400);
    assert.match(await unlisted.text(), /invalid redirect_uri/);
  } finally {
    idp.close();
  }
});

test("a token can be requested for this app's login or one of its library links only", async () => {
  const idp = await startIdp();
  try {
    const page = (resource?: string) =>
      fetch(
        `${idp.base}/id/authorize?${new URLSearchParams({ ...mcpParams, ...(resource ? { resource } : {}) })}`,
      );
    assert.equal((await page()).status, 200);
    assert.equal((await page("http://127.0.0.1:3000")).status, 200);
    assert.equal((await page(LIBRARY_RESOURCE)).status, 200);

    for (const resource of [
      "https://other-service.example/api",
      "http://127.0.0.1:3000/libraries/not-a-uuid/mcp/" + "t".repeat(43),
      LIBRARY_RESOURCE + "?x=1",
      "http://127.0.0.1:3000/accounts",
      "not a url",
    ]) {
      const denied = await page(resource);
      assert.equal(denied.status, 400, resource);
      assert.match(await denied.text(), /invalid resource/);
    }
  } finally {
    idp.close();
  }
});

test("a correct password does not get a code for a foreign audience", async () => {
  const idp = await startIdp();
  try {
    const signIn = (resource: string) =>
      fetch(`${idp.base}/id/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...mcpParams, resource, username: "ada", password: PASSWORD }),
        redirect: "manual",
      });
    const denied = await signIn("https://other-service.example/api");
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get("location"), null);
    const allowed = await signIn(LIBRARY_RESOURCE);
    assert.equal(allowed.status, 302);
    assert.ok(new URL(allowed.headers.get("location") ?? "").searchParams.get("code"));
  } finally {
    idp.close();
  }
});
