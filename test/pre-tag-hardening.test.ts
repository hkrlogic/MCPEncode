import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { memoryIdpStore, type IdpStore } from "../src/auth/idp-store.ts";
import { KNOWN_GOOD_MS, type KnownGoodStore, knownGoodKey, SignInLimit } from "../src/auth/signin-limit.ts";
import type { AppConfig } from "../src/config.ts";
import { postgresIdpStore, postgresKnownGoodStore } from "../src/db/idp-store.ts";
import { FORWARDED_WITHOUT_TRUST_PROXY, forwardedForWarning } from "../src/http/proxy-warning.ts";
import { withTestDatabase } from "./db.ts";

const CALLBACK = "http://127.0.0.1:33418/callback";
const SECRET = "test-session-secret-32-bytes-minimum!!";

async function startIdp(overrides: Partial<AppConfig>, store: IdpStore = memoryIdpStore()) {
  const accounts = memoryAccountStore();
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mcpencode-web",
    oauthRegisterRateLimit: 0,
    ...overrides,
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts, { store });
  const app = express();
  // Trust the test's X-Forwarded-For so each request can pick its address.
  app.set("trust proxy", "loopback");
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function register(base: string, from: string) {
  return fetch(`${base}/id/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify({ redirect_uris: [CALLBACK] }),
  });
}

test("X-Forwarded-For without TRUST_PROXY logs one warning", async () => {
  const messages: string[] = [];
  const app = express();
  app.use(forwardedForWarning((message) => messages.push(message)));
  app.get("/", (_req, res) => {
    res.send("ok");
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/`;
    await fetch(url);
    assert.equal(messages.length, 0);
    await fetch(url, { headers: { "x-forwarded-for": "203.0.113.5" } });
    await fetch(url, { headers: { "x-forwarded-for": "203.0.113.6" } });
    assert.deepEqual(messages, [FORWARDED_WITHOUT_TRUST_PROXY]);
    assert.match(messages[0] ?? "", /TRUST_PROXY/);
    assert.match(messages[0] ?? "", /one address/);
  } finally {
    server.close();
  }
});

test("pending registrations are capped per address, IPv6 per /64", async () => {
  const s = await startIdp({ oauthMaxPendingClientsPerAddress: 2 });
  try {
    assert.equal((await register(s.base, "2001:db8:1:1::1")).status, 201);
    assert.equal((await register(s.base, "2001:db8:1:1::ffff")).status, 201);
    // Same /64: refused.
    const refused = await register(s.base, "2001:db8:1:1:abcd::9");
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "3600");
    assert.equal(((await refused.json()) as { error: string }).error, "too_many_requests");
    // Another /64 and an IPv4 address have their own budget.
    assert.equal((await register(s.base, "2001:db8:1:2::1")).status, 201);
    assert.equal((await register(s.base, "203.0.113.7")).status, 201);
  } finally {
    s.close();
  }
});

test("the global OAUTH_MAX_PENDING_CLIENTS still applies", async () => {
  const s = await startIdp({ oauthMaxPendingClients: 2, oauthMaxPendingClientsPerAddress: 20 });
  try {
    assert.equal((await register(s.base, "203.0.113.1")).status, 201);
    assert.equal((await register(s.base, "203.0.113.2")).status, 201);
    assert.equal((await register(s.base, "203.0.113.3")).status, 503);
  } finally {
    s.close();
  }
});

test("never-used registrations expire after the pending TTL (default 1 hour)", async () => {
  const store = memoryIdpStore();
  const s = await startIdp({ oauthMaxPendingClientsPerAddress: 1 }, store);
  try {
    const hourAgo = Date.now() - 61 * 60 * 1000;
    const first = await register(s.base, "203.0.113.9");
    assert.equal(first.status, 201);
    const { client_id } = (await first.json()) as { client_id: string };
    // Age the registration past the TTL: it is pruned and the address may register again.
    const saved = await store.findClient(client_id);
    assert.ok(saved);
    await store.saveClient({ ...saved, createdAt: hourAgo });
    assert.equal((await register(s.base, "203.0.113.9")).status, 201);
    assert.equal(await store.findClient(client_id), undefined);
  } finally {
    s.close();
  }
});

test("Postgres counts pending registrations per address", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresIdpStore(db, SECRET);
    const now = Date.now();
    const a = "a".repeat(64);
    await store.saveClient({ clientId: "mcp_1", clientName: "", redirectUris: [], createdAt: now, registeredFrom: a });
    await store.saveClient({ clientId: "mcp_2", clientName: "", redirectUris: [], createdAt: now, registeredFrom: a });
    await store.saveClient({ clientId: "mcp_3", clientName: "", redirectUris: [], createdAt: now, registeredFrom: "b".repeat(64) });
    await store.saveClient({ clientId: "mcp_old", clientName: "", redirectUris: [], createdAt: 1, registeredFrom: a });
    assert.equal(await store.countPendingClientsFrom(now - 1000, a), 2);
    assert.equal(await store.countPendingClients(now - 1000), 3);
  });
});

function memoryKnownGood(): KnownGoodStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  return {
    rows,
    async load(since, limit) {
      return [...rows].filter(([, at]) => at >= since).slice(-limit).map(([key, at]) => ({ key, at }));
    },
    async remember(key, at) {
      rows.set(key, at);
    },
  };
}

test("known-good sign-in addresses survive a restart", async () => {
  let now = 1_000_000_000;
  const store = memoryKnownGood();
  const before = new SignInLimit({ now: () => now, usernameAllowance: 1, knownGoodStore: store });
  assert.ok(before.begin("ada", "2001:db8:5:5::1"));
  before.succeed("ada", "2001:db8:5:5::1");
  await new Promise((resolve) => setImmediate(resolve));
  // Stored hashed, never in the clear.
  const [key] = [...store.rows.keys()];
  assert.equal(key, knownGoodKey("ada", "2001:db8:5:5::/64"));
  assert.doesNotMatch(key ?? "", /ada|2001/);

  // A new process: an attacker spends the username-wide allowance from elsewhere.
  const after = new SignInLimit({ now: () => now, usernameAllowance: 2, knownGoodStore: store });
  await after.restore();
  assert.ok(after.begin("ada", "198.51.100.1"));
  assert.ok(after.begin("ada", "198.51.100.2"));
  assert.equal(after.blocked("ada", "198.51.100.3"), true);
  // The SA's usual /64 is still let through.
  assert.equal(after.blocked("ada", "2001:db8:5:5::abcd"), false);

  // Entries past 30 days are not restored.
  now += KNOWN_GOOD_MS + 1;
  const late = new SignInLimit({ now: () => now, knownGoodStore: store });
  await late.restore();
  assert.equal(late.size().knownGood, 0);
});

test("Postgres keeps known-good addresses bounded and expiring", async () => {
  await withTestDatabase(async (db) => {
    const store = postgresKnownGoodStore(db);
    const now = 10_000_000;
    const [k1, k2, k3, k4] = ["1", "2", "3", "4"].map((digit) => digit.repeat(64));
    await store.remember(k1, now - 100, now - 1000, 2);
    await store.remember(k2, now - 50, now - 1000, 2);
    await store.remember(k1, now, now - 1000, 2); // upsert refreshes
    assert.deepEqual(await store.load(0, 10), [
      { key: k2, at: now - 50 },
      { key: k1, at: now },
    ]);
    await store.remember(k3, now + 1, now - 1000, 2); // cap 2: oldest goes
    assert.deepEqual(
      (await store.load(0, 10)).map((row) => row.key),
      [k1, k3],
    );
    await store.remember(k4, now + 5000, now + 2, 10); // expiry drops older rows
    assert.deepEqual(
      (await store.load(0, 10)).map((row) => row.key),
      [k4],
    );

    const limit = new SignInLimit({ knownGoodStore: store });
    assert.ok(limit.begin("ada", "203.0.113.4"));
    limit.succeed("ada", "203.0.113.4");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restored = new SignInLimit({ knownGoodStore: store });
    await restored.restore();
    assert.ok(restored.size().knownGood >= 1);
  });
});
