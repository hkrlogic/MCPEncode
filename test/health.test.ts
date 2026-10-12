/** GET /healthz: no auth, no Host check, 200 with Postgres up, 503 without it. */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { AppConfig } from "../src/config.ts";
import type { Database } from "../src/db/types.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { healthHandler } from "../src/http/health.ts";
import { withTestDatabase } from "./db.ts";

function testConfig(): AppConfig {
  const origin = "http://127.0.0.1:3000";
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    publicBaseUrl: origin,
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: `${origin}/id`,
    authJwksUrl: `${origin}/id/jwks`,
    authAudience: origin,
    webClientId: "mcpencode-web",
    sessionSecret: "test-session-secret-32-bytes-minimum!!",
    database: {
      host: "127.0.0.1",
      port: 5432,
      user: "mcpencode",
      password: "stub-not-a-real-password",
      database: "mcpencode",
      ssl: false,
    },
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

/** A database whose every call fails, like Postgres being down. */
function downDatabase(): Database {
  const fail = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
  return {
    exec: fail,
    all: fail,
    get: fail,
    run: fail,
    prepare: fail,
    transaction: fail,
    close: () => Promise.resolve(),
  };
}

/** GET with an explicit Host header (fetch does not let a caller set Host). */
function get(port: number, path: string, host: string) {
  return new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), text }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test("healthz returns 200 with Postgres up, with no auth and any Host", async () => {
  await withTestDatabase(async (db) => {
    const config = testConfig();
    const app = createApp({ config, db, authServer: stubAuthServer(config.authIssuer) });
    const server = await listen(app);
    try {
      const local = await get(server.port, "/healthz", `127.0.0.1:${server.port}`);
      assert.equal(local.status, 200);
      assert.match(local.type, /application\/json/);
      assert.deepEqual(JSON.parse(local.text), { status: "ok", database: "ok" });

      // Platform probes may send an internal Host name. Health still answers…
      const probe = await get(server.port, "/healthz", "healthcheck.internal.example");
      assert.equal(probe.status, 200);

      // …while every other route keeps the Host allowlist.
      const other = await get(server.port, "/", "healthcheck.internal.example");
      assert.equal(other.status, 403);
    } finally {
      await server.close();
    }
  });
});

test("healthz returns 503 when Postgres cannot be reached", async () => {
  const config = testConfig();
  const app = createApp({ config, db: downDatabase(), authServer: stubAuthServer(config.authIssuer) });
  const server = await listen(app);
  const originalError = console.error;
  console.error = () => {};
  try {
    const down = await get(server.port, "/healthz", `127.0.0.1:${server.port}`);
    assert.equal(down.status, 503);
    assert.deepEqual(JSON.parse(down.text), { status: "unavailable", database: "unreachable" });
    // The driver error stays in the log, not the response.
    assert.equal(down.text.includes("ECONNREFUSED"), false);
  } finally {
    console.error = originalError;
    await server.close();
  }
});

test("healthz returns 503 when the database check hangs", async () => {
  const hanging = { ...downDatabase(), get: () => new Promise<unknown>(() => {}) };
  const app = express();
  app.get("/healthz", healthHandler(hanging, 50));
  const server = await listen(app);
  const originalError = console.error;
  console.error = () => {};
  try {
    const slow = await get(server.port, "/healthz", "127.0.0.1");
    assert.equal(slow.status, 503);
  } finally {
    console.error = originalError;
    await server.close();
  }
});
