/**
 * Small request-handling fixes: cookie parsing, cookie prefixes, CSRF
 * compare, CSRF before upload bytes, and the trust proxy setting.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Request } from "express";
import type { AppConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { cookieHeader, cookieName, parseCookies, readCookie } from "../src/http/cookies.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { requireCsrf, sessionAccess, tokensMatch } from "../src/http/helpers.ts";
import { readItemUpload } from "../src/http/upload.ts";

test("a malformed %-escape skips that cookie instead of throwing", () => {
  assert.deepEqual(parseCookies("bad=%E0%A4%A; good=ok%20yes"), { good: "ok yes" });
  assert.deepEqual(parseCookies("=x; a=%"), {});
});

test("a malformed cookie does not turn a page into a 500", async () => {
  const config = { publicBaseUrl: "http://127.0.0.1:3000", sessionSecret: "x".repeat(32) } as AppConfig;
  const req = { headers: { cookie: "mpos_session=%E0%A4%A" }, app: { locals: {} } } as unknown as Request;
  assert.equal(await sessionAccess(req, config), undefined);
});

test("on HTTPS cookies get the __Host- prefix (or __Secure- when path-scoped)", () => {
  assert.equal(cookieName("mpos_session", { secure: false }), "mpos_session");
  assert.equal(cookieName("mpos_session", { secure: true }), "__Host-mpos_session");
  assert.equal(cookieName("mpos_consent", { secure: true, path: "/id" }), "__Secure-mpos_consent");
  const header = cookieHeader("mpos_session", "v", { secure: true });
  assert.match(header, /^__Host-mpos_session=v; Path=\/; SameSite=Lax; HttpOnly; Secure/);
  assert.doesNotMatch(header, /Domain=/);
  // Reading uses the same name, so a bare cookie planted by a subdomain is ignored.
  const headers = { cookie: "mpos_session=planted; __Host-mpos_session=real" };
  assert.equal(readCookie(headers, "mpos_session", { secure: true }), "real");
  assert.equal(readCookie({ cookie: "mpos_session=planted" }, "mpos_session", { secure: true }), undefined);
  assert.equal(readCookie(headers, "mpos_session"), "planted");
});

test("CSRF tokens compare in constant time and never match when empty", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abd", "abc"), false);
  assert.equal(tokensMatch("ab", "abc"), false);
  assert.equal(tokensMatch("", ""), false);
  const req = (body: unknown, headers: Record<string, string> = {}) => ({ body, headers }) as unknown as Request;
  assert.equal(requireCsrf(req({ csrf: "t0k" }), "t0k"), true);
  assert.equal(requireCsrf(req({}, { "x-csrf-token": "t0k" }), "t0k"), true);
  assert.equal(requireCsrf(req({ csrf: "nope" }), "t0k"), false);
  assert.equal(requireCsrf(req({}), ""), false);
});

function multipart(parts: Array<{ name: string; value: string; filename?: string }>) {
  const boundary = "----test-boundary";
  const body = parts
    .map((part) =>
      part.filename
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: application/pdf\r\n\r\n${part.value}\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
    )
    .join("");
  return { body: `${body}--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
}

test("an upload checks the CSRF token before reading any file bytes", async () => {
  const app = express();
  app.post("/upload", async (req, res) => {
    const result = await readItemUpload(req, (token) => tokensMatch(token, "good-token"));
    if (!result.ok && result.code === "csrf") res.setHeader("Connection", "close");
    res.json({ ok: result.ok, code: result.ok ? "ok" : result.code, bytes: result.ok ? result.bytes.length : 0 });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (parts: Parameters<typeof multipart>[0], headers: Record<string, string> = {}) => {
    const form = multipart(parts);
    const res = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { "content-type": form.type, ...headers },
      body: form.body,
    });
    return (await res.json()) as { ok: boolean; code: string; bytes: number };
  };
  try {
    const file = { name: "file", value: "%PDF-1.4 hello", filename: "a.pdf" };
    assert.deepEqual(await send([{ name: "csrf", value: "good-token" }, file]), { ok: true, code: "ok", bytes: 14 });
    assert.equal((await send([{ name: "csrf", value: "bad-token" }, file])).code, "csrf");
    // A token that only comes after the file is too late.
    assert.equal((await send([file, { name: "csrf", value: "good-token" }])).code, "csrf");
    assert.equal((await send([file])).code, "csrf");
    // The header works for scripts that cannot order fields.
    assert.equal((await send([file], { "x-csrf-token": "good-token" })).code, "ok");
    assert.equal((await send([{ name: "csrf", value: "good-token" }, file], { "x-csrf-token": "bad" })).code, "csrf");
  } finally {
    server.close();
  }
});

function stubAuthServer(issuer: string): AuthServerEndpoints {
  return {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

test("Express trusts X-Forwarded-For only when TRUST_PROXY is set", () => {
  const base = {
    port: 3000,
    bindHost: "0.0.0.0",
    publicBaseUrl: "https://library.example.org",
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: "https://library.example.org/id",
    authJwksUrl: "https://library.example.org/id/jwks",
    authAudience: "https://library.example.org",
    webClientId: "mpos-web",
    sessionSecret: "x".repeat(32),
  } as unknown as AppConfig;
  const db = {} as Parameters<typeof createApp>[0]["db"];
  // A public bind alone no longer turns it on.
  const off = createApp({ config: base, db, authServer: stubAuthServer(base.authIssuer) });
  assert.equal(off.get("trust proxy"), false);
  const on = createApp({ config: { ...base, trustProxy: 1 }, db, authServer: stubAuthServer(base.authIssuer) });
  assert.equal(on.get("trust proxy"), 1);
});
