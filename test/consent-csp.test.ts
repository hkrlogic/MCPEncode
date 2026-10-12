import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import type { AppConfig } from "../src/config.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import { cspWithFormAction, ENFORCED_CSP, formActionSource, securityHeaders } from "../src/http/security-headers.ts";
import { answerConsent, readConsent, registerClient } from "./oauth-flow.ts";

const PASSWORD = "correct horse battery";
const VERIFIER = "v".repeat(64);

async function start(overrides: Partial<AppConfig> = {}) {
  const accounts = memoryAccountStore();
  assert.ok((await accounts.create({ username: "ada", password: PASSWORD, role: "sa" })).ok);
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mcpencode-web",
    authMode: "embedded",
    sessionSecret: "s".repeat(40),
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts, {});
  const app = express();
  app.use(securityHeaders({ https: false }));
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function signIn(base: string, redirectUri: string) {
  const res = await registerClient(base, [redirectUri]);
  assert.equal(res.status, 201, await res.clone().text());
  const clientId = ((await res.json()) as { client_id: string }).client_id;
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "st",
  };
  const authorize = await fetch(`${base}/id/authorize?${new URLSearchParams(params)}`);
  const page = await fetch(`${base}/id/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, username: "ada", password: PASSWORD }),
    redirect: "manual",
  });
  return { authorize, page };
}

function formAction(csp: string | null): string {
  return /form-action ([^;]*)/.exec(csp ?? "")?.[1] ?? "";
}

test("formActionSource gives an origin, a scheme, or nothing", () => {
  assert.equal(formActionSource("https://claude.ai/api/mcp/auth_callback?x=1"), "https://claude.ai");
  assert.equal(formActionSource("http://127.0.0.1:33418/callback"), "http://127.0.0.1:33418");
  assert.equal(formActionSource("http://[::1]:8080/cb"), "http://[::1]:8080");
  assert.equal(formActionSource("cursor://anysphere.cursor-mcp/oauth/callback"), "cursor:");
  assert.equal(formActionSource("com.example.app:/oauth"), "com.example.app:");
  assert.equal(formActionSource("not a url"), undefined);
  assert.equal(formActionSource("https://a.example/'; script-src *"), "https://a.example");
});

test("cspWithFormAction only adds safe single tokens", () => {
  assert.equal(cspWithFormAction([]), ENFORCED_CSP);
  assert.equal(cspWithFormAction([undefined]), ENFORCED_CSP);
  const csp = cspWithFormAction(["https://claude.ai", "https://claude.ai"]);
  assert.equal(formAction(csp), "'self' https://claude.ai");
  assert.match(csp, /script-src 'self'$/);
});

for (const [label, uri, source] of [
  ["https", "https://client.example.test/cb", "https://client.example.test"],
  ["loopback", "http://127.0.0.1:43123/callback", "http://127.0.0.1:43123"],
  ["app scheme", "cursor://anysphere.cursor-mcp/oauth/callback", "cursor:"],
] as const) {
  test(`the consent page lets its form reach the ${label} callback, and nothing else does`, async () => {
    const s = await start({ oauthRedirectHosts: ["client.example.test"] });
    try {
      const { authorize, page } = await signIn(s.base, uri);
      assert.equal(formAction(authorize.headers.get("content-security-policy")), "'self'");
      assert.equal(formAction(page.headers.get("content-security-policy")), `'self' ${source}`);
      const consent = await readConsent(page);
      const denied = await answerConsent(s.base, consent, "deny");
      assert.equal(denied.status, 302);
      const location = denied.headers.get("location") ?? "";
      assert.ok(location.startsWith(uri.split("?")[0] ?? uri));
      assert.equal(new URL(location).searchParams.get("error"), "access_denied");
      assert.equal(new URL(location).searchParams.get("state"), "st");
      assert.equal(formAction(denied.headers.get("content-security-policy")), "'self'");
    } finally {
      await s.close();
    }
  });
}

test("the approve-host → consent step carries the callback origin too", async () => {
  const s = await start();
  try {
    const uri = "https://pending.example.test/cb";
    const { page } = await signIn(s.base, uri);
    assert.equal(formAction(page.headers.get("content-security-policy")), "'self'");
    const html = await page.text();
    const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = /mcpencode_consent=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const approved = await fetch(`${s.base}/id/approve-host`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `mcpencode_consent=${cookie}` },
      body: new URLSearchParams({ consent_id: consentId, decision: "approve" }),
    });
    assert.equal(formAction(approved.headers.get("content-security-policy")), "'self' https://pending.example.test");
    const consent = await readConsent(approved);
    assert.equal((await answerConsent(s.base, consent)).status, 302);
    // Sending the same answer again gets a clear page, not a bare line.
    const again = await answerConsent(s.base, consent);
    assert.equal(again.status, 400);
    assert.match(again.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await again.text(), /already submitted or has expired\. Go back to the app and start again\./);
  } finally {
    await s.close();
  }
});
