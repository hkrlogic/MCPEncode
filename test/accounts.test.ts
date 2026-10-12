import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WEB_OAUTH } from "./oauth-flow.ts";
import { memoryAccountStore, type Account } from "../src/auth/accounts.ts";
import { createEmbeddedIdp } from "../src/auth/embedded-idp.ts";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/passwords.ts";
import { ROLE_PERMISSIONS } from "../src/auth/rbac.ts";
import { signSession } from "../src/auth/session.ts";
import { accountStore } from "../src/db/accounts.ts";
import type { AppConfig } from "../src/config.ts";
import { SESSION_COOKIE } from "../src/http/helpers.ts";
import { accountsPage } from "../src/http/pages/accounts.ts";
import { registerAccountRoutes } from "../src/http/routes/accounts.ts";
import type { AppRouteContext } from "../src/http/routes/context.ts";
import { withTestDatabase } from "./db.ts";

const config = {
  publicBaseUrl: "http://127.0.0.1:3000",
  authIssuer: "http://127.0.0.1:3000/id",
  authAudience: "http://127.0.0.1:3000",
  webClientId: "mcpencode-web",
  // Test-only switch (no env var): these tests are about accounts, not the setup code.
  setupCodeRequired: false,
} as AppConfig;

test("passwords are stored as scrypt hashes", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.equal(hash.includes("correct horse battery"), false);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong horse battery", hash), false);
  assert.equal(await verifyPassword("correct horse battery", "not-a-hash"), false);
  assert.equal(await verifyPassword("correct horse battery", "scrypt$99999999$8$1$aaaa$bbbb"), false);
});

test("old, cheaper scrypt hashes still verify and are flagged for upgrade", async () => {
  const { scryptSync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  const key = scryptSync("correct horse battery", salt, 32, { N: 16384, r: 8, p: 1 });
  const old = `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
  assert.equal(await verifyPassword("correct horse battery", old), true);
  assert.equal(needsRehash(old), true);
  assert.equal(needsRehash(await hashPassword("correct horse battery")), false);
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
  const params = new URLSearchParams(WEB_OAUTH);
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
    const stored = await accounts.findByUsername(wins[0]?.ok ? wins[0].account.username : "");
    assert.equal(stored?.passwordHash.includes("correct horse battery"), false);
  });
});

const password = "correct horse battery";

test("the last active SA cannot be turned off or disabled", async () => {
  const accounts = memoryAccountStore();
  const first = await accounts.createFirst({ username: "only", password });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const demoted = await accounts.setSa(first.account.id, false);
  assert.deepEqual(demoted, { ok: false, message: "Keep at least one active SA account." });
  const disabled = await accounts.setDisabled(first.account.id, true);
  assert.deepEqual(disabled, { ok: false, message: "Keep at least one active SA account." });
  assert.equal((await accounts.findById(first.account.id))?.role, "sa");

  const other = await accounts.create({ username: "other", password, role: "readonly" });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  // A normal account does not count. The only SA still cannot be removed.
  assert.equal((await accounts.setSa(first.account.id, false)).ok, false);

  const promoted = await accounts.setSa(other.account.id, true);
  assert.equal(promoted.ok, true);
  const removed = await accounts.setSa(first.account.id, false);
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.account.role, "readonly");
  // The remaining SA is now locked.
  assert.equal((await accounts.setSa(other.account.id, false)).ok, false);
});

test("two SA demotions at once still leave one SA", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const first = await accounts.createFirst({ username: "one", password });
    const second = await accounts.create({ username: "two", password, role: "sa" });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    const [left, right] = await Promise.all([
      accounts.setSa(first.account.id, false),
      accounts.setSa(second.account.id, false),
    ]);
    const succeeded = [left, right].filter((result) => result.ok);
    assert.equal(succeeded.length, 1);
    const stillSa = (await accounts.list()).filter((row) => row.role === "sa" && !row.disabled);
    assert.equal(stillSa.length, 1);
  });
});

test("Accounts refuses a posted demotion of the last SA", async () => {
  await withTestDatabase(async (db) => {
    const accounts = accountStore(db);
    const first = await accounts.createFirst({ username: "only", password });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const secret = "s".repeat(40);
    const csrf = "csrf-token-for-last-sa";
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    registerAccountRoutes(app, {
      config: { ...config, authMode: "embedded", sessionSecret: secret },
      db,
    } as AppRouteContext);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const token = await signSession(
      { sub: first.account.id, clientId: "mcpencode-web", role: "sa", csrf },
      secret,
    );
    try {
      const blocked = await fetch(`http://127.0.0.1:${port}/accounts/${first.account.id}/sa`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        },
        body: new URLSearchParams({ csrf, sa: "0" }),
      });
      const html = await blocked.text();
      assert.equal(blocked.status, 400);
      assert.match(html, /Keep at least one active SA account/);
      assert.match(html, /At least one SA must stay on/);
      assert.match(html, /type="button"/);
      assert.doesNotMatch(html, new RegExp(`action="/accounts/${first.account.id}/sa"`));
      assert.equal((await accounts.findById(first.account.id))?.role, "sa");
    } finally {
      server.close();
    }
  });
});

function accountRow(partial: Partial<Account> & Pick<Account, "id" | "username" | "role">): Account {
  return { disabled: false, ...partial };
}

test("the last SA switch is not a form that can turn SA off", () => {
  const access = {
    sub: "sa-1",
    clientId: "test",
    role: "sa" as const,
    permissions: ROLE_PERMISSIONS.sa,
  };
  const shell = {
    libraries: [],
    orphans: [],
    csrf: "token",
    canAddLibrary: true,
    username: "only",
    roleLabel: "SA",
    showAccounts: true,
  };
  const alone = accountsPage({
    access,
    csrf: "token",
    shell,
    accounts: [accountRow({ id: "sa-1", username: "only", role: "sa" })],
    local: true,
  });
  assert.match(alone, /At least one SA must stay on/);
  assert.match(alone, /type="button"[^>]*disabled/);
  assert.doesNotMatch(alone, /action="\/accounts\/sa-1\/sa"/);

  const shared = accountsPage({
    access,
    csrf: "token",
    shell,
    accounts: [
      accountRow({ id: "sa-1", username: "only", role: "sa" }),
      accountRow({ id: "sa-2", username: "other", role: "sa" }),
    ],
    local: true,
  });
  assert.match(shared, /action="\/accounts\/sa-1\/sa"/);
  assert.doesNotMatch(shared, /At least one SA must stay on/);
});
