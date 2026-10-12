import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { hashPassword, setHashConcurrency, DEFAULT_HASH_CONCURRENCY } from "../src/auth/passwords.ts";
import { QueueFullError, Semaphore } from "../src/auth/semaphore.ts";
import { SIGN_IN_WAIT, SignInLimit } from "../src/auth/signin-limit.ts";
import type { AppConfig } from "../src/config.ts";
import { registeredClientId } from "./oauth-flow.ts";

const MINUTE = 60 * 1000;

test("misses on one username from one address back off, then the wait ends", () => {
  let now = 1_000;
  const limit = new SignInLimit({ now: () => now, pairAllowance: 3 });
  for (let i = 0; i < 3; i += 1) assert.equal(limit.begin("ada", "203.0.113.5"), true);
  // Fourth try waits 1s, the next 2s, then 4s …
  assert.equal(limit.begin("ada", "203.0.113.5"), false);
  now += 1000;
  assert.equal(limit.begin("ada", "203.0.113.5"), true);
  now += 1000;
  assert.equal(limit.blocked("ada", "203.0.113.5"), true);
  now += 1000;
  assert.equal(limit.begin("ada", "203.0.113.5"), true);
  now += 3999;
  assert.equal(limit.blocked("ada", "203.0.113.5"), true);
  now += 1;
  assert.equal(limit.blocked("ada", "203.0.113.5"), false);
  // Fifteen quiet minutes and the count starts over.
  now += 15 * MINUTE;
  for (let i = 0; i < 3; i += 1) assert.equal(limit.begin("ada", "203.0.113.5"), true);
});

test("someone guessing at the SA does not lock the SA out from another address", () => {
  let now = 1_000;
  const limit = new SignInLimit({ now: () => now });
  for (let i = 0; i < 60; i += 1) {
    limit.begin("sa", "198.51.100.66");
    now += 20 * MINUTE; // the attacker waits out every backoff
  }
  // A tight loop from the attacker is slowed down …
  for (let i = 0; i < 10; i += 1) limit.begin("sa", "198.51.100.66");
  assert.equal(limit.blocked("sa", "198.51.100.66"), true);
  // … while the SA, elsewhere, signs in at once.
  assert.equal(limit.begin("sa", "203.0.113.7"), true);
  limit.succeed("sa", "203.0.113.7");
  assert.equal(limit.blocked("sa", "203.0.113.7"), false);
});

test("the wait never grows past the cap", () => {
  let now = 1_000;
  const limit = new SignInLimit({ now: () => now, pairAllowance: 1, maxDelayMs: 2 * MINUTE, windowMs: 60 * MINUTE });
  for (let i = 0; i < 40; i += 1) {
    while (!limit.begin("ada", "203.0.113.5")) now += 1000;
  }
  assert.equal(limit.blocked("ada", "203.0.113.5"), true);
  now += 2 * MINUTE;
  assert.equal(limit.blocked("ada", "203.0.113.5"), false);
});

test("many usernames from one address back off that address only", () => {
  const limit = new SignInLimit({ addressAllowance: 3 });
  assert.equal(limit.begin("one", "198.51.100.8"), true);
  assert.equal(limit.begin("two", "198.51.100.8"), true);
  assert.equal(limit.begin("three", "198.51.100.8"), true);
  assert.equal(limit.begin("four", "198.51.100.8"), false);
  assert.equal(limit.begin("one", "198.51.100.9"), true);
});

test("misses on one username from many addresses slow that username down", () => {
  const limit = new SignInLimit({ usernameAllowance: 4 });
  for (let i = 0; i < 4; i += 1) assert.equal(limit.begin("sa", `192.0.2.${i}`), true);
  assert.equal(limit.begin("sa", "192.0.2.200"), false);
  assert.equal(limit.begin("ada", "192.0.2.200"), true);
});

test("a successful sign-in takes its count back and clears that username", () => {
  const limit = new SignInLimit({ pairAllowance: 2, addressAllowance: 2 });
  assert.equal(limit.begin("ada", "203.0.113.5"), true);
  assert.equal(limit.begin("ada", "203.0.113.5"), true);
  assert.equal(limit.blocked("ada", "203.0.113.5"), true);
  limit.succeed("ada", "203.0.113.5");
  assert.equal(limit.blocked("ada", "203.0.113.5"), false);
  // The address keeps the one miss that was not taken back.
  assert.equal(limit.begin("bob", "203.0.113.5"), true);
  assert.equal(limit.blocked("carol", "203.0.113.5"), true);
});

test("the semaphore runs only so many at once and refuses a full queue", async () => {
  const gate = new Semaphore(2, 1);
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const job = () =>
    gate.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    });
  const first = job();
  const second = job();
  const third = job();
  await assert.rejects(job(), QueueFullError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.running, 2);
  assert.equal(gate.queued, 1);
  releases.shift()?.();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();
  releases.shift()?.();
  await Promise.all([second, third]);
  assert.equal(peak, 2);
  assert.equal(gate.running, 0);
});

test("password hashes go through the concurrency cap", async () => {
  setHashConcurrency(1);
  try {
    await hashPassword("warm up the pool");
    const started = Date.now();
    const one = Date.now();
    await hashPassword("correct horse battery");
    const single = Date.now() - one;
    await Promise.all([hashPassword("a password here"), hashPassword("another password"), hashPassword("third password!")]);
    // Three hashes one at a time take clearly longer than one.
    assert.ok(Date.now() - started >= single * 2.5);
  } finally {
    setHashConcurrency(DEFAULT_HASH_CONCURRENCY);
  }
});

test("the sign-in form counts the try before hashing and stops checking after the limit", async () => {
  const accounts = memoryAccountStore();
  const created = await accounts.create({
    username: "ada",
    password: "correct horse battery",
    role: "sa",
  });
  assert.equal(created.ok, true);
  let checks = 0;
  const original = accounts.findByUsername.bind(accounts);
  accounts.findByUsername = async (username) => {
    checks += 1;
    return original(username);
  };
  const limit = new SignInLimit({ pairAllowance: 2 });
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mcpencode-web",
  } as AppConfig;
  const idp = await createEmbeddedIdp(config, accounts, { signInLimit: limit });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const params = {
    client_id: await registeredClientId(base, ["http://127.0.0.1:8765/oauth/callback"]),
    redirect_uri: "http://127.0.0.1:8765/oauth/callback",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  };
  async function post(password: string) {
    return fetch(`${base}/id/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, username: "ada", password }),
      redirect: "manual",
    });
  }
  try {
    // Five wrong passwords at once: only the allowance gets a password check.
    const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => post(`wrong-password-${n}`)));
    const texts = await Promise.all(burst.map((response) => response.text()));
    assert.equal(texts.filter((text) => /Unknown username or password/.test(text)).length, 2);
    assert.equal(texts.filter((text) => text.includes(SIGN_IN_WAIT)).length, 3);
    const blocked = await post("correct horse battery");
    assert.equal(blocked.status, 200);
    assert.ok((await blocked.text()).includes(SIGN_IN_WAIT));
    assert.equal(checks, 2);
  } finally {
    server.close();
  }
});
