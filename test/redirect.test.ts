import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import {
  callbackHost,
  callbackKind,
  callbackLabel,
  isAllowedCallback,
  redirectMatches,
} from "../src/auth/redirect.ts";

const check = {
  clientId: "mcp_test",
  webClientId: "mcpencode-web",
  publicBaseUrl: "http://127.0.0.1:3000",
};

test("by default MCP clients may return only to loopback or an app scheme (RFC 8252)", () => {
  // Claude Code, MCP Inspector, mcp-remote, VS Code
  assert.equal(isAllowedCallback("http://localhost:8787/callback", check), true);
  assert.equal(isAllowedCallback("http://127.0.0.1:8765/oauth/callback", check), true);
  assert.equal(isAllowedCallback("http://[::1]:9000/callback", check), true);
  assert.equal(isAllowedCallback("http://localhost:6274/oauth/callback", check), true);
  // Cursor, and reverse-domain private-use schemes
  assert.equal(isAllowedCallback("cursor://anysphere.cursor-mcp/oauth/callback", check), true);
  assert.equal(isAllowedCallback("com.example.app:/oauth2redirect", check), true);
  // A remote host is not accepted unless the operator lists it.
  assert.equal(isAllowedCallback("https://evil.example/cb", check), false);
  assert.equal(isAllowedCallback("https://www.perplexity.ai/rest/connections/oauth_callback", check), false);
  assert.equal(isAllowedCallback("http://evil.example/cb", check), false);
});

test("OAUTH_REDIRECT_HOSTS lets a listed https host through, and nothing like it", () => {
  const listed = { ...check, allowedHosts: ["claude.ai", "www.perplexity.ai"] };
  assert.equal(isAllowedCallback("https://claude.ai/api/mcp/auth_callback", listed), true);
  assert.equal(isAllowedCallback("https://www.perplexity.ai/oauth", listed), true);
  assert.equal(isAllowedCallback("https://evil.example/cb", listed), false);
  assert.equal(isAllowedCallback("https://claude.ai.evil.example/cb", listed), false);
  assert.equal(isAllowedCallback("https://sub.claude.ai/cb", listed), false);
  // Listed, but plain http to a remote host is never accepted.
  assert.equal(isAllowedCallback("http://claude.ai/cb", listed), false);
  assert.equal(callbackKind("https://claude.ai/cb", listed), "listed-host");
});

test("an unlisted https host is never accepted (there is no any-https switch)", () => {
  assert.equal(isAllowedCallback("https://anything.example/cb", check), false);
  assert.equal(callbackKind("https://anything.example/cb", {}), undefined);
});

test("browser schemes and credentialed URLs are rejected", () => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/steal",
    "blob:https://x/y",
    "ws://127.0.0.1:1/cb",
    "http://user:pass@127.0.0.1/callback",
    "http://127.0.0.1/callback#code",
    "not a url",
  ]) {
    assert.equal(isAllowedCallback(uri, { ...check, allowedHosts: ["127.0.0.1", "x"] }), false, uri);
  }
});

test("the publisher sign-in returns only to this app", () => {
  const web = { ...check, clientId: "mcpencode-web" };
  assert.equal(isAllowedCallback("http://127.0.0.1:3000/callback", web), true);
  assert.equal(isAllowedCallback("https://evil.example/callback", web), false);
  assert.equal(isAllowedCallback("http://127.0.0.1:3000/callback?next=https://evil.example", web), false);
  assert.equal(isAllowedCallback("http://localhost:9999/callback", web), false);
});

test("a requested callback must match a registered one exactly, except a loopback IP port", () => {
  const registered = ["http://127.0.0.1:33418/callback", "cursor://anysphere.cursor-mcp/oauth/callback"];
  assert.equal(redirectMatches("http://127.0.0.1:33418/callback", registered), true);
  assert.equal(redirectMatches("cursor://anysphere.cursor-mcp/oauth/callback", registered), true);
  // RFC 8252 section 7.3: the port of a loopback IP callback may change.
  assert.equal(redirectMatches("http://127.0.0.1:50123/callback", registered), true);
  // Anything else must be exact.
  assert.equal(redirectMatches("http://127.0.0.1:50123/other", registered), false);
  assert.equal(redirectMatches("http://127.0.0.1:50123/callback?x=1", registered), false);
  assert.equal(redirectMatches("https://127.0.0.1:33418/callback", registered), false);
  assert.equal(redirectMatches("cursor://anysphere.cursor-mcp/oauth/callback2", registered), false);
  assert.equal(redirectMatches("http://localhost:33418/callback", registered), false);
  assert.equal(redirectMatches("http://localhost:1/cb", ["http://localhost:2/cb"]), false);
});

test("the sign-in page names the return address and host", () => {
  assert.equal(
    callbackLabel("https://www.perplexity.ai/rest/connections/oauth_callback"),
    "https://www.perplexity.ai/rest/connections/oauth_callback",
  );
  assert.equal(
    callbackLabel("cursor://anysphere.cursor-mcp/oauth/callback"),
    "cursor://anysphere.cursor-mcp/oauth/callback",
  );
  assert.equal(callbackHost("http://127.0.0.1:8765/cb"), "127.0.0.1:8765");
  assert.equal(callbackHost("cursor://anysphere.cursor-mcp/oauth/callback"), "cursor://anysphere.cursor-mcp");
  assert.equal(callbackHost("com.example.app:/cb"), "com.example.app:");
});

test("authorize and register turn away a remote callback by default", async () => {
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mcpencode-web",
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, memoryAccountStore());
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const params = (clientId: string, redirect: string) =>
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      });
    const evil = await fetch(`${base}/id/authorize?${params("mcp_unregistered", "https://evil.example/cb")}`);
    assert.equal(evil.status, 400);

    const web = await fetch(`${base}/id/authorize?${params("mcpencode-web", "https://evil.example/cb")}`);
    assert.equal(web.status, 400);

    for (const uris of [["https://203.0.113.9/cb"], ["http://evil.example/cb"], ["https://user@evil.example/cb"], ["http://127.0.0.1:1/cb", "javascript:alert(1)"], [], "x"]) {
      const registered = await fetch(`${base}/id/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: uris }),
      });
      assert.equal(registered.status, 400, JSON.stringify(uris));
      assert.equal(((await registered.json()) as { error: string }).error, "invalid_redirect_uri");
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});
