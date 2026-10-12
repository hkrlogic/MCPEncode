import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import type { AppConfig } from "../src/config.ts";
import { answerConsent, readConsent, registeredClientId } from "./oauth-flow.ts";

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
    webClientId: "mcpencode-web",
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const callbacks = [mcpParams.redirect_uri];
  if (overrides.oauthRedirectHosts?.includes("claude.ai")) callbacks.push("https://claude.ai/cb");
  mcpParams.client_id = await registeredClientId(base, callbacks);
  return { base, close: () => server.close() };
}

/** client_id is the one the latest startIdp registered. */
const mcpParams = {
  client_id: "",
  redirect_uri: "http://127.0.0.1:8765/oauth/callback",
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
    assert.match(html, /you will be sent to <strong>http:\/\/127\.0\.0\.1:8765\/oauth\/callback<\/strong>/);
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
      client_id: "mcpencode-web",
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
    const unlisted = await fetch(
      `${idp.base}/id/authorize?${new URLSearchParams({ ...mcpParams, redirect_uri: "https://evil.example/cb" })}`,
    );
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
    // The header form (X-Library-Token) connects to the library without the token in the path.
    assert.equal((await page(LIBRARY_RESOURCE.replace(/\/[^/]+$/, ""))).status, 200);

    for (const resource of [
      "https://other-service.example/api",
      "http://127.0.0.1:3000/libraries/not-a-uuid/mcp/" + "t".repeat(43),
      LIBRARY_RESOURCE + "?x=1",
      LIBRARY_RESOURCE + "/extra",
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
    const consent = await readConsent(await signIn(LIBRARY_RESOURCE));
    const allowed = await answerConsent(idp.base, consent);
    assert.equal(allowed.status, 302);
    assert.ok(new URL(allowed.headers.get("location") ?? "").searchParams.get("code"));
  } finally {
    idp.close();
  }
});
