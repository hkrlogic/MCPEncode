import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { SIGN_IN_WAIT, SignInLimit } from "../src/auth/signin-limit.ts";
import type { AppConfig } from "../src/config.ts";

test("misses on a username have to wait, then the wait ends", () => {
  let now = 1_000;
  const limit = new SignInLimit(() => now, 15 * 60 * 1000, 5, 20);
  for (let i = 0; i < 5; i += 1) limit.recordFailure("ada", "203.0.113.5");
  assert.equal(limit.blocked("ada", "203.0.113.9"), true);
  assert.equal(limit.blocked("other", "203.0.113.9"), false);
  now += 15 * 60 * 1000;
  assert.equal(limit.blocked("ada", "203.0.113.9"), false);
});

test("many misses from one address have to wait", () => {
  const limit = new SignInLimit(Date.now, 15 * 60 * 1000, 5, 3);
  limit.recordFailure("one", "198.51.100.8");
  limit.recordFailure("two", "198.51.100.8");
  limit.recordFailure("three", "198.51.100.8");
  assert.equal(limit.blocked("four", "198.51.100.8"), true);
  assert.equal(limit.blocked("one", "198.51.100.9"), false);
});

test("a successful sign-in clears the wait for that username", () => {
  const limit = new SignInLimit(Date.now, 15 * 60 * 1000, 2, 20);
  limit.recordFailure("ada", "203.0.113.5");
  limit.recordFailure("ada", "203.0.113.5");
  assert.equal(limit.blocked("ada", "203.0.113.5"), true);
  limit.recordSuccess("ada", "203.0.113.5");
  assert.equal(limit.blocked("ada", "203.0.113.5"), false);
});

test("the sign-in form stops checking passwords after the username limit", async () => {
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
  const limit = new SignInLimit(Date.now, 15 * 60 * 1000, 2, 20);
  const config = {
    publicBaseUrl: "http://127.0.0.1:3000",
    authIssuer: "http://127.0.0.1:3000/id",
    authAudience: "http://127.0.0.1:3000",
    webClientId: "mpos-web",
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
    client_id: "mpos-mcp",
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
    const first = await post("wrong-password-1");
    assert.match(await first.text(), /Unknown username or password/);
    const second = await post("wrong-password-2");
    assert.match(await second.text(), /Unknown username or password/);
    const blocked = await post("correct horse battery");
    assert.equal(blocked.status, 200);
    assert.match(await blocked.text(), new RegExp(SIGN_IN_WAIT.replace(".", "\\.")));
    assert.equal(checks, 2);
  } finally {
    server.close();
  }
});
