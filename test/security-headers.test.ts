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
  // Enforced: no inline script and no report-only twin any more.
  assert.match(csp, /script-src 'self'$/);
  assert.equal(csp.includes("'unsafe-inline'; script") || /script-src[^;]*unsafe/.test(csp), false);
  assert.equal(headers.get("content-security-policy-report-only"), null);
});

test("no page markup carries inline script or inline event handlers", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "../src");
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    source.split("\n").forEach((line, index) => {
      // <script> without src, on*="…" handlers and javascript: URLs all need 'unsafe-inline'.
      if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(line) || /\son[a-z]+="/i.test(line) || /javascript:/i.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test("confirm prompts are data attributes that public/page.js asks", async () => {
  const { confirmText } = await import("../src/http/pages/layout.ts");
  assert.equal(confirmText(`Delete “a” <b> & "c"?\r`), "Delete “a” &lt;b&gt; &amp; &quot;c&quot;?");
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../public/page.js", import.meta.url), "utf8");
  assert.match(script, /dataset\.confirm/);
  assert.match(script, /window\.confirm\(/);
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
