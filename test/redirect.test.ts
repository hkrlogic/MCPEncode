import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { callbackLabel, isAllowedCallback } from "../src/auth/redirect.ts";

const check = {
  clientId: "mpos-mcp",
  webClientId: "mpos-web",
  publicBaseUrl: "http://127.0.0.1:3000",
};

test("MCP clients may return to any absolute callback", () => {
  assert.equal(isAllowedCallback("https://www.perplexity.ai/rest/connections/oauth_callback", check), true);
  assert.equal(isAllowedCallback("http://localhost:8787/callback", check), true);
  assert.equal(isAllowedCallback("http://127.0.0.1:8765/oauth/callback", check), true);
  assert.equal(isAllowedCallback("cursor://anysphere.cursor-mcp/oauth/callback", check), true);
  assert.equal(
    isAllowedCallback("https://new-client.example/oauth/callback?x=1", check),
    true,
  );
});

test("browser schemes and credentialed URLs are rejected", () => {
  assert.equal(isAllowedCallback("javascript:alert(1)", check), false);
  assert.equal(isAllowedCallback("data:text/html,hi", check), false);
  assert.equal(isAllowedCallback("file:///tmp/steal", check), false);
  assert.equal(isAllowedCallback("https://user:pass@evil.example/callback", check), false);
  assert.equal(isAllowedCallback("https://evil.example/callback#code", check), false);
  assert.equal(isAllowedCallback("not a url", check), false);
});

test("the publisher sign-in returns only to this app", () => {
  const web = { ...check, clientId: "mpos-web" };
  assert.equal(isAllowedCallback("http://127.0.0.1:3000/callback", web), true);
  assert.equal(isAllowedCallback("https://evil.example/callback", web), false);
  assert.equal(isAllowedCallback("http://127.0.0.1:3000/callback?next=https://evil.example", web), false);
});

test("the sign-in page names the return address", () => {
  assert.equal(
    callbackLabel("https://www.perplexity.ai/rest/connections/oauth_callback"),
    "https://www.perplexity.ai/rest/connections/oauth_callback",
  );
  assert.equal(
    callbackLabel("cursor://anysphere.cursor-mcp/oauth/callback"),
    "cursor://anysphere.cursor-mcp/oauth/callback",
  );
});

test("authorize accepts a callback that was not on the old list", async () => {
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000/mcp",
    webClientId: "mpos-web",
  } as AppConfig;
  const idp = await createEmbeddedIdp(config);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const redirect = "https://brand-new-client.example/oauth/callback";
    const params = new URLSearchParams({
      client_id: "mpos-mcp",
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const page = await fetch(`${base}/id/authorize?${params}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /brand-new-client\.example/);

    const blocked = await fetch(
      `${base}/id/authorize?${new URLSearchParams({
        client_id: "mpos-web",
        redirect_uri: redirect,
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    );
    assert.equal(blocked.status, 400);

    const registered = await fetch(`${base}/id/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect, "javascript:alert(1)"] }),
    });
    assert.equal(registered.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});
