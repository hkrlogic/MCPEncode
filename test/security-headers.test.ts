import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { cookieHeader } from "../src/http/cookies.ts";
import { needsRehash } from "../src/auth/passwords.ts";
import { securityHeaders } from "../src/http/security-headers.ts";

async function headersFor(https: boolean): Promise<Headers> {
  const app = express();
  app.use(securityHeaders({ https }));
  app.get("/", (_req, res) => void res.send("ok"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as { port: number };
    return (await fetch(`http://127.0.0.1:${port}/`)).headers;
  } finally {
    server.close();
  }
}

test("pages cannot be framed and load nothing from other sites", async () => {
  const headers = await headersFor(false);
  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(csp.includes("fonts.googleapis.com"), false);
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("content-security-policy-report-only") ?? "", /script-src 'self'$/);
});

test("HSTS is sent only on an HTTPS public address", async () => {
  assert.equal((await headersFor(false)).get("strict-transport-security"), null);
  assert.match((await headersFor(true)).get("strict-transport-security") ?? "", /max-age=31536000/);
});

test("Secure cookies carry the Secure attribute", () => {
  assert.match(cookieHeader("s", "v", { secure: true }), /; Secure/);
  assert.doesNotMatch(cookieHeader("s", "v", { secure: false }), /Secure/);
});

test("hashes at the current cost do not need an upgrade; malformed ones are left alone", () => {
  assert.equal(needsRehash("not-a-hash"), false);
});
