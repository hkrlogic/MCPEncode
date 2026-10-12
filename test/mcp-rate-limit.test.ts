/**
 * MCP_RATE_LIMIT_PER_MINUTE: library MCP routes are limited per client
 * address, and that address follows TRUST_PROXY.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DEFAULT_MCP_RATE_LIMIT_PER_MINUTE, parseMcpRateLimit, parseTrustProxy, type AppConfig } from "../src/config.ts";
import type { Database } from "../src/db/types.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";

const LIBRARY = "00000000-0000-4000-8000-000000000001";

function testConfig(overrides: Partial<AppConfig>): AppConfig {
  const origin = "http://127.0.0.1:34571";
  return {
    port: 34571,
    bindHost: "127.0.0.1",
    publicBaseUrl: origin,
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: `${origin}/id`,
    authJwksUrl: `${origin}/id/jwks`,
    authAudience: origin,
    webClientId: "mpos-web",
    sessionSecret: "test-session-secret-32-bytes-minimum!!",
    database: { host: "127.0.0.1", port: 5432, user: "mpos", password: "stub", database: "mpos", ssl: false },
    ...overrides,
  };
}

function stubAuthServer(issuer: string): AuthServerEndpoints {
  return {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

/**
 * The limiter answers before any library lookup, and a malformed token or a
 * missing X-Library-Token is refused before the database, so no database is needed.
 */
async function startApp(overrides: Partial<AppConfig>) {
  const config = testConfig(overrides);
  const app = createApp({ config, db: {} as Database, authServer: stubAuthServer(config.authIssuer) });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

function hit(base: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

const PATH_ROUTE = `/libraries/${LIBRARY}/mcp/not-a-connect-token`;
const HEADER_ROUTE = `/libraries/${LIBRARY}/mcp`;

test("MCP_RATE_LIMIT_PER_MINUTE defaults to 300, 0 turns it off, junk is refused", () => {
  assert.equal(DEFAULT_MCP_RATE_LIMIT_PER_MINUTE, 300);
  assert.equal(parseMcpRateLimit(undefined), 300);
  assert.equal(parseMcpRateLimit(" "), 300);
  assert.equal(parseMcpRateLimit("0"), 0);
  assert.equal(parseMcpRateLimit("1200"), 1200);
  for (const bad of ["-1", "1.5", "lots", "100001"]) {
    assert.throws(() => parseMcpRateLimit(bad), /MCP_RATE_LIMIT_PER_MINUTE/);
  }
});

test("under the limit passes with RateLimit headers; over it gets a JSON-RPC 429", async () => {
  const app = await startApp({ mcpRateLimitPerMinute: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      const ok = await hit(app.base, PATH_ROUTE);
      // Past the limiter: the route's own answer for a malformed token.
      assert.equal(ok.status, 404);
      assert.match(ok.headers.get("ratelimit-policy") ?? "", /q=3; w=60/);
      assert.match(ok.headers.get("ratelimit") ?? "", new RegExp(`r=${2 - i}`));
      await ok.body?.cancel();
    }
    const limited = await hit(app.base, PATH_ROUTE);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.match(limited.headers.get("content-type") ?? "", /application\/json/);
    const body = (await limited.json()) as { jsonrpc: string; id: null; error: { code: number; message: string } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /3 per minute/);
  } finally {
    app.close();
  }
});

test("the X-Library-Token route shares the same per-address count", async () => {
  const app = await startApp({ mcpRateLimitPerMinute: 2 });
  try {
    assert.equal((await hit(app.base, HEADER_ROUTE)).status, 410);
    assert.equal((await hit(app.base, PATH_ROUTE)).status, 404);
    assert.equal((await hit(app.base, HEADER_ROUTE, { "x-library-token": "x" })).status, 429);
    assert.equal((await hit(app.base, PATH_ROUTE)).status, 429);
  } finally {
    app.close();
  }
});

test("MCP_RATE_LIMIT_PER_MINUTE=0 disables the limit", async () => {
  const app = await startApp({ mcpRateLimitPerMinute: 0 });
  try {
    for (let i = 0; i < 20; i += 1) {
      const response = await hit(app.base, PATH_ROUTE);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("ratelimit"), null);
      await response.body?.cancel();
    }
  } finally {
    app.close();
  }
});

test("behind a trusted proxy, separate client addresses are counted separately", async () => {
  const app = await startApp({ mcpRateLimitPerMinute: 2, trustProxy: parseTrustProxy("loopback") });
  try {
    const a = { "x-forwarded-for": "203.0.113.10" };
    const b = { "x-forwarded-for": "203.0.113.20" };
    assert.equal((await hit(app.base, PATH_ROUTE, a)).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, a)).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, a)).status, 429);
    // Another address has its own budget.
    assert.equal((await hit(app.base, PATH_ROUTE, b)).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, b)).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, b)).status, 429);
  } finally {
    app.close();
  }
});

test("without TRUST_PROXY a forged X-Forwarded-For does not buy a fresh count", async () => {
  const app = await startApp({ mcpRateLimitPerMinute: 2 });
  try {
    assert.equal((await hit(app.base, PATH_ROUTE, { "x-forwarded-for": "198.51.100.1" })).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, { "x-forwarded-for": "198.51.100.2" })).status, 404);
    assert.equal((await hit(app.base, PATH_ROUTE, { "x-forwarded-for": "198.51.100.3" })).status, 429);
  } finally {
    app.close();
  }
});

test("no express-rate-limit validation error in any TRUST_PROXY mode", async () => {
  const logged: string[] = [];
  const original = { error: console.error, warn: console.warn };
  const capture = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${(arg as { code?: string }).code ?? ""}` : String(arg))).join(" "));
  };
  console.error = capture;
  console.warn = capture;
  try {
    for (const raw of [undefined, "false", "0", "1", "2", "loopback", "uniquelocal", "127.0.0.1,10.0.0.0/8"]) {
      const headerSets: Record<string, string>[] = [
        {},
        { "x-forwarded-for": "203.0.113.7" },
        { "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
        { forwarded: "for=203.0.113.7" },
        { "x-forwarded-for": "2001:db8::1" },
      ];
      for (const headers of headerSets) {
        // A fresh limiter each time: each check runs on a limiter's first request only.
        const app = await startApp({ mcpRateLimitPerMinute: 5, trustProxy: parseTrustProxy(raw) });
        try {
          const response = await hit(app.base, PATH_ROUTE, headers);
          assert.equal(response.status, 404, `TRUST_PROXY=${raw} ${JSON.stringify(headers)}`);
          await response.body?.cancel();
        } finally {
          app.close();
        }
      }
    }
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
  assert.deepEqual(logged.filter((line) => /ERR_ERL|ValidationError|express-rate-limit/i.test(line)), []);
});
