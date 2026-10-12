import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore, type AccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp, type IdpAuditEvent } from "../src/auth/embedded-idp.ts";
import { hashRefreshToken, memoryIdpStore, type IdpStore } from "../src/auth/idp-store.ts";
import { approvableCallbackHost, isApprovableHostname } from "../src/auth/redirect.ts";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import { accountStore } from "../src/db/accounts.ts";
import { postgresIdpStore } from "../src/db/idp-store.ts";
import { allRows } from "../src/db/query-helpers.ts";
import { writeAudit } from "../src/db/audit.ts";
import { SESSION_COOKIE } from "../src/http/helpers.ts";
import { pkceChallenge } from "../src/http/pkce.ts";
import { registerCallbackHostRoutes } from "../src/http/routes/callback-hosts.ts";
import type { AppRouteContext } from "../src/http/routes/context.ts";
import { withTestDatabase } from "./db.ts";
import { answerConsent, readConsent, registerClient } from "./oauth-flow.ts";

const PASSWORD = "correct horse battery";
const HOSTED = "https://client.example.test/cb";
const VERIFIER = "v".repeat(64);
const SECRET = "s".repeat(40);

const baseConfig = {
  publicBaseUrl: "http://127.0.0.1:3000",
  authIssuer: "http://127.0.0.1:3000/id",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mcpencode-web",
  authMode: "embedded",
  sessionSecret: SECRET,
} as AppConfig;

async function start(
  overrides: Partial<AppConfig> = {},
  input: { store?: IdpStore; accounts?: AccountStore; db?: AppRouteContext["db"] } = {},
) {
  const accounts = input.accounts ?? memoryAccountStore();
  if ((await accounts.count()) === 0) {
    assert.ok((await accounts.create({ username: "ada", password: PASSWORD, role: "sa" })).ok);
    assert.ok((await accounts.create({ username: "bob", password: PASSWORD, role: "readonly" })).ok);
  }
  const config = { ...baseConfig, ...overrides } as AppConfig;
  const audits: IdpAuditEvent[] = [];
  const db = input.db;
  const idp = await createEmbeddedIdp(config, accounts, {
    store: input.store,
    audit: async (event) => {
      audits.push(event);
      if (db) await writeAudit(db, event);
    },
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  if (db) registerCallbackHostRoutes(app, { config, db, callbackHosts: idp.callbackHosts } as AppRouteContext);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    idp,
    accounts,
    audits,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function params(clientId: string, redirectUri = HOSTED) {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "st",
  };
}

async function registerHosted(base: string, uri = HOSTED, name = "Hosted Chat"): Promise<string> {
  const res = await registerClient(base, [uri], name);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { client_id: string }).client_id;
}

function signIn(base: string, p: Record<string, string>, username: string) {
  return fetch(`${base}/id/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...p, username, password: PASSWORD }),
    redirect: "manual",
  });
}

/** Read the approve page's consent id and cookie. */
async function readApprove(res: Response) {
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Approve client\.example\.test and continue/);
  const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
  const cookie = /mcpencode_consent=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(consentId && cookie);
  return { consentId, cookie: `mcpencode_consent=${cookie}` };
}

function approveHost(base: string, a: { consentId: string; cookie?: string }, decision = "approve") {
  return fetch(`${base}/id/approve-host`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(a.cookie ? { cookie: a.cookie } : {}) },
    body: new URLSearchParams({ consent_id: a.consentId, decision }),
    redirect: "manual",
  });
}

async function exchange(base: string, clientId: string, code: string) {
  const res = await fetch(`${base}/id/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: HOSTED,
      code_verifier: VERIFIER,
    }),
  });
  return { status: res.status, json: (await res.json()) as { access_token?: string; refresh_token?: string } };
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: await run(), lines };
  } finally {
    console.warn = original;
  }
}

test("only https DNS hostnames can be approved", () => {
  assert.equal(approvableCallbackHost("https://Client.Example.test/cb"), "client.example.test");
  for (const uri of [
    "http://client.example.test/cb",
    "https://203.0.113.9/cb",
    "https://[2001:db8::1]/cb",
    "https://0x7f.1/cb",
    "https://user:pw@client.example.test/cb",
    "https://client.example.test/cb#frag",
    "https://localhost/cb",
    "https://intranet/cb",
    "cursor://callback",
    "microsoft-edge:https://client.example.test/",
  ]) {
    assert.equal(approvableCallbackHost(uri), undefined, uri);
  }
  assert.equal(isApprovableHostname("-bad.example"), false);
  assert.equal(isApprovableHostname("xn--bcher-kva.example"), true);
});

test("an unapproved https callback is logged once with a copy-paste line and gets a friendly page", async () => {
  const s = await start();
  try {
    const { result: clientId, lines } = await captureWarnings(() => registerHosted(s.base));
    const joined = lines.join("\n");
    assert.match(joined, /host=client\.example\.test/);
    assert.match(joined, new RegExp(`client_id=${clientId}`));
    assert.match(joined, /client_name="Hosted Chat" \(self-reported, unverified\)/);
    assert.match(joined, /^OAUTH_REDIRECT_HOSTS=client\.example\.test$/m);

    const again = await captureWarnings(async () => {
      const page = await fetch(`${s.base}/id/authorize?${new URLSearchParams(await params(clientId))}`);
      return { status: page.status, html: await page.text() };
    });
    assert.equal(again.result.status, 200);
    assert.match(again.result.html, /This app&#39;s callback host client\.example\.test isn&#39;t approved yet|This app's callback host client\.example\.test isn't approved yet/);
    assert.match(again.result.html, /A site admin can approve it/);
    assert.equal(again.lines.length, 0, "same host and client is not logged twice");

    // A non-SA person sees the waiting page and no code is issued.
    const waiting = await signIn(s.base, await params(clientId), "bob");
    assert.equal(waiting.status, 403);
    assert.match(await waiting.text(), /Waiting for your site admin to approve this app/);
    assert.equal(waiting.headers.get("location"), null);
  } finally {
    await s.close();
  }
});

test("register names the host in its JSON error when it cannot be approved or is denied", async () => {
  const s = await start();
  try {
    const ip = await registerClient(s.base, ["https://203.0.113.9/cb"]);
    assert.equal(ip.status, 400);
    assert.equal(((await ip.json()) as { callback_host?: string }).callback_host, "203.0.113.9");
    await s.idp.callbackHosts.decide({ host: "client.example.test", decision: "deny", by: "admin" });
    const denied = await registerClient(s.base, [HOSTED]);
    assert.equal(denied.status, 400);
    const body = (await denied.json()) as { callback_host?: string; error_description: string };
    assert.equal(body.callback_host, "client.example.test");
    assert.match(body.error_description, /denied/);
  } finally {
    await s.close();
  }
});

test("pending hosts are capped and rate-limited per address", async () => {
  const s = await start({ oauthMaxPendingCallbackHosts: 2, oauthPendingHostRateLimit: 3 });
  try {
    await captureWarnings(async () => {
      await registerHosted(s.base, "https://a.example.test/cb");
      await registerHosted(s.base, "https://b.example.test/cb");
      // The same host again adds no row and is not counted by the per-address limit.
      await registerHosted(s.base, "https://b.example.test/cb");
      const full = await registerClient(s.base, ["https://c.example.test/cb"]);
      assert.equal(full.status, 503);
      assert.equal(((await full.json()) as { callback_host?: string }).callback_host, "c.example.test");
      const limited = await registerClient(s.base, ["https://d.example.test/cb"]);
      assert.equal(limited.status, 429);
      // Loopback registrations are not affected.
      assert.equal((await registerClient(s.base, ["http://127.0.0.1:4000/cb"])).status, 201);
    });
    const listed = await s.idp.callbackHosts.list();
    assert.deepEqual(listed.hosts.map((row) => row.host).sort(), ["a.example.test", "b.example.test"]);
  } finally {
    await s.close();
  }
});

test("the site admin approves inline and the sign-in completes; the decision is audited", async () => {
  const s = await start();
  try {
    const clientId = await captureWarnings(() => registerHosted(s.base)).then((r) => r.result);
    const approve = await readApprove(await signIn(s.base, await params(clientId), "ada"));
    // The approve step is not a consent answer.
    assert.equal((await answerConsent(s.base, approve)).status, 400);
    const approve2 = await readApprove(await signIn(s.base, await params(clientId), "ada"));
    // Without its cookie (another site posting the form) it is refused.
    assert.equal((await approveHost(s.base, { consentId: approve2.consentId })).status, 400);
    assert.equal((await s.idp.callbackHosts.list()).hosts[0]?.status, "pending");

    const approve3 = await readApprove(await signIn(s.base, await params(clientId), "ada"));
    const consentPage = await approveHost(s.base, approve3);
    const consent = await readConsent(consentPage);
    const allowed = await answerConsent(s.base, consent);
    assert.equal(allowed.status, 302);
    const location = new URL(allowed.headers.get("location") ?? "");
    assert.equal(`${location.origin}${location.pathname}`, HOSTED);
    const code = location.searchParams.get("code");
    assert.ok(code);
    const token = await exchange(s.base, clientId, code);
    assert.equal(token.status, 200);
    assert.ok(token.json.refresh_token);

    const row = (await s.idp.callbackHosts.list()).hosts[0];
    assert.equal(row?.status, "approved");
    assert.equal(row?.sampleClientName, "Hosted Chat");
    assert.ok(row?.decidedBy);
    assert.deepEqual(s.audits.map((event) => event.tool), ["callback_host.approve"]);
    assert.match(s.audits[0]?.detail ?? "", /host=client\.example\.test/);

    // Later sign-ins skip the approve step.
    assert.match(await (await signIn(s.base, await params(clientId), "bob")).text(), /Allow access\?/);
  } finally {
    await s.close();
  }
});

test("a demoted admin cannot use an approve page they were shown", async () => {
  const s = await start();
  try {
    const clientId = await captureWarnings(() => registerHosted(s.base)).then((r) => r.result);
    const approve = await readApprove(await signIn(s.base, await params(clientId), "ada"));
    const ada = await s.accounts.findByUsername("ada");
    assert.ok(ada);
    // Keep another SA so the demotion is allowed.
    const bob = await s.accounts.findByUsername("bob");
    assert.ok(bob);
    await s.accounts.setSa(bob.id, true);
    await s.accounts.setSa(ada.id, false);
    assert.equal((await approveHost(s.base, approve)).status, 403);
    assert.equal((await s.idp.callbackHosts.list()).hosts[0]?.status, "pending");
  } finally {
    await s.close();
  }
});

test("a denied host shows a friendly page and no sign-in form", async () => {
  const s = await start();
  try {
    const clientId = await captureWarnings(() => registerHosted(s.base)).then((r) => r.result);
    await s.idp.callbackHosts.decide({ host: "client.example.test", decision: "deny", by: "admin" });
    const page = await fetch(`${s.base}/id/authorize?${new URLSearchParams(await params(clientId))}`);
    assert.equal(page.status, 403);
    const html = await page.text();
    assert.match(html, /was denied by a site admin/);
    assert.doesNotMatch(html, /name="password"/);
  } finally {
    await s.close();
  }
});

test("revoking a host ends refresh tokens of its clients and blocks new sign-ins", async () => {
  const store = memoryIdpStore();
  const s = await start({}, { store });
  try {
    const clientId = await captureWarnings(() => registerHosted(s.base)).then((r) => r.result);
    await s.idp.callbackHosts.decide({ host: "client.example.test", decision: "approve", by: "admin" });
    const consent = await readConsent(await signIn(s.base, await params(clientId), "bob"));
    const code = new URL((await answerConsent(s.base, consent)).headers.get("location") ?? "").searchParams.get("code");
    assert.ok(code);
    const token = await exchange(s.base, clientId, code);
    assert.ok(token.json.refresh_token);

    const revoked = await s.idp.callbackHosts.decide({ host: "client.example.test", decision: "revoke", by: "admin" });
    assert.ok(revoked.ok);
    if (revoked.ok) assert.equal(revoked.revokedTokens, 1);
    const claim = await store.claimRefresh(hashRefreshToken(token.json.refresh_token ?? ""), Date.now());
    assert.equal(claim.status, "missing");
    assert.equal((await fetch(`${s.base}/id/authorize?${new URLSearchParams(await params(clientId))}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("hosts in OAUTH_REDIRECT_HOSTS still work without any approval", async () => {
  const s = await start({ oauthRedirectHosts: ["client.example.test"] });
  try {
    const { result: clientId, lines } = await captureWarnings(() => registerHosted(s.base));
    assert.equal(lines.length, 0);
    assert.match(await (await signIn(s.base, await params(clientId), "bob")).text(), /Allow access\?/);
    assert.equal((await s.idp.callbackHosts.list()).hosts.length, 0);
  } finally {
    await s.close();
  }
});

test("Settings → Apps: SA approves, denies and revokes with CSRF; others cannot (Postgres)", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const first = await accounts.createFirst({ username: "ada", password: PASSWORD });
    assert.ok(first.ok);
    const bob = await accounts.create({ username: "bob", password: PASSWORD, role: "readonly" });
    assert.ok(first.ok && bob.ok);
    if (!first.ok || !bob.ok) return;
    const store = postgresIdpStore(db, SECRET);
    const s = await start({ setupCodeRequired: false }, { store, accounts, db });
    const csrf = "csrf-for-apps-page";
    const cookieFor = async (sub: string, role: "sa" | "readonly") =>
      `${SESSION_COOKIE}=${encodeURIComponent(await signSession({ sub, clientId: "mcpencode-web", role, csrf }, SECRET))}`;
    const sa = await cookieFor(first.account.id, "sa");
    const reader = await cookieFor(bob.account.id, "readonly");
    const decide = (cookie: string, body: Record<string, string>) =>
      fetch(`${s.base}/apps/decide`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    try {
      const clientId = await captureWarnings(() => registerHosted(s.base)).then((r) => r.result);
      const page = await fetch(`${s.base}/apps`, { headers: { cookie: sa } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /client\.example\.test/);
      assert.match(html, /Hosted Chat.*\(unverified\)/);
      assert.doesNotMatch(html, /<script>/);
      assert.equal((await fetch(`${s.base}/apps`, { headers: { cookie: reader } })).status, 403);

      const host = "client.example.test";
      assert.equal((await decide(reader, { csrf, host, decision: "approve" })).status, 403);
      assert.equal((await decide(sa, { csrf: "wrong", host, decision: "approve" })).status, 403);
      assert.equal((await store.findHost(host))?.status, "pending");

      assert.equal((await decide(sa, { csrf, host, decision: "approve" })).status, 302);
      assert.equal((await store.findHost(host))?.status, "approved");
      assert.equal((await store.findHost(host))?.decidedBy, first.account.id);

      // Sign in to get a refresh token, then revoke.
      const consent = await readConsent(await signIn(s.base, await params(clientId), "bob"));
      const code = new URL((await answerConsent(s.base, consent)).headers.get("location") ?? "").searchParams.get("code");
      const token = await exchange(s.base, clientId, code ?? "");
      assert.ok(token.json.refresh_token);
      assert.equal((await decide(sa, { csrf, host, decision: "revoke" })).status, 302);
      assert.equal((await store.findHost(host))?.status, "denied");
      const refreshed = await fetch(`${s.base}/id/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.json.refresh_token ?? "", client_id: clientId }),
      });
      assert.equal(refreshed.status, 400);

      assert.equal((await decide(sa, { csrf, host: "203.0.113.9", decision: "approve" })).status, 400);
      const audit = await allRows<{ tool: string; actor_sub: string; detail: string }>(
        db,
        "SELECT tool, actor_sub, detail FROM audit_events WHERE tool LIKE 'callback_host.%' ORDER BY created_at",
      );
      assert.deepEqual(audit.map((row) => row.tool), ["callback_host.approve", "callback_host.revoke"]);
      assert.match(audit[1]?.detail ?? "", /revoked_refresh_tokens=1/);
    } finally {
      await s.close();
    }
  });
});

test("the Postgres pending-host cap holds", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresIdpStore(db, SECRET);
    const now = Date.now();
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((x) => store.notePendingHost({ host: `${x}.example.test`, clientName: "", now, maxPending: 2 })),
    );
    assert.equal(results.filter((r) => r === "created").length, 2);
    assert.equal(results.filter((r) => r === "full").length, 2);
    assert.equal(await store.notePendingHost({ host: "a.example.test", clientName: "X", now: now + 1, maxPending: 2 }), "seen");
    assert.deepEqual(await store.approvedHosts(), []);
  });
});
