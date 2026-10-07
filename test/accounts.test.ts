import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { memoryAccountStore } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { hashPassword, verifyPassword } from "../src/auth/passwords.ts";
import { accountStore } from "../src/db/accounts.ts";
import type { AppConfig } from "../src/config.ts";
import { withTestDatabase } from "./db.ts";

const config = {
  publicBaseUrl: "http://127.0.0.1:3000",
  authIssuer: "http://127.0.0.1:3000/id",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mpos-web",
} as AppConfig;

test("passwords are stored as scrypt hashes", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.equal(hash.includes("correct horse battery"), false);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong horse battery", hash), false);
  assert.equal(await verifyPassword("correct horse battery", "not-a-hash"), false);
  assert.equal(await verifyPassword("correct horse battery", "scrypt$99999999$8$1$aaaa$bbbb"), false);
});

test("the first visit creates an account and later visits sign in", async () => {
  const accounts = memoryAccountStore();
  const idp = await createEmbeddedIdp(config, accounts);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  idp.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const params = new URLSearchParams({
    client_id: "mpos-mcp",
    redirect_uri: "https://brand-new-client.example/oauth/callback",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
  try {
    const page = await fetch(`${base}/id/authorize?${params}`);
    const html = await page.text();
    assert.match(html, /Create account/);
    assert.equal(html.includes("editor-pass"), false);

    const short = await fetch(`${base}/id/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        setup: "1",
        username: "Ada",
        password: "too-short",
        password_confirm: "too-short",
      }),
      redirect: "manual",
    });
    assert.equal(short.status, 200);
    assert.match(await short.text(), /at least 12 characters/);
    assert.equal(await accounts.count(), 0);

    const created = await fetch(`${base}/id/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        setup: "1",
        username: "Ada",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
      }),
      redirect: "manual",
    });
    assert.equal(created.status, 302);
    const location = created.headers.get("location") ?? "";
    assert.match(location, /code=/);
    const account = await accounts.findByUsername("ada");
    assert.equal(account?.role, "sa");
    assert.equal(account?.passwordHash.includes("correct horse battery"), false);

    const again = await fetch(`${base}/id/authorize?${params}`);
    assert.match(await again.text(), /Sign in/);

    const wrong = await fetch(`${base}/id/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        username: "ada",
        password: "not-the-password",
      }),
      redirect: "manual",
    });
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /Unknown username or password/);

    const right = await fetch(`${base}/id/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        username: "ada",
        password: "correct horse battery",
      }),
      redirect: "manual",
    });
    assert.equal(right.status, 302);
  } finally {
    server.close();
  }
});

test("only one first account can be created", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const [first, second] = await Promise.all([
      accounts.createFirst({ username: "one", password: "correct horse battery" }),
      accounts.createFirst({ username: "two", password: "correct horse battery" }),
    ]);
    const wins = [first, second].filter((result) => result.ok);
    assert.equal(wins.length, 1);
    assert.equal(await accounts.count(), 1);
    const stored = await accounts.findByUsername(wins[0] && wins[0].ok ? wins[0].account.username : "");
    assert.equal(stored?.passwordHash.includes("correct horse battery"), false);
  });
});
