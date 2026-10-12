/**
 * Configuration comes only from documented env vars (PUBLIC_BASE_URL, PORT,
 * BIND_HOST, DATABASE_URL / POSTGRES_*). Nothing is inferred from the host platform.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, loadDatabaseConfig, OAUTH_LIMITS, parseTrustProxy, warnIgnoredEnv } from "../src/config.ts";
import { REMOVED_ENV_VARS } from "../src/env-schema.ts";

const KEYS = [
  "PUBLIC_BASE_URL",
  "MCP_RESOURCE_URL",
  "BIND_HOST",
  "PORT",
  "SESSION_SECRET",
  "SETUP_TOKEN",
  "AUTH_MODE",
  "DATABASE_URL",
  "POSTGRES_HOST",
  "PGHOST",
  "POSTGRES_PORT",
  "PGPORT",
  "POSTGRES_USER",
  "PGUSER",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "POSTGRES_DATABASE",
  "PGDATABASE",
  "POSTGRES_DB",
  "POSTGRES_SSL",
  "POSTGRES_CONNECT_TIMEOUT_SECONDS",
  "OAUTH_REDIRECT_HOSTS",
  "TRUST_PROXY",
  "AUTH_ISSUER",
  "AUTH_AUDIENCE",
  "AUTH_MCP_AUDIENCE",
  "ALLOW_INSECURE_HTTP",
  ...REMOVED_ENV_VARS,
];

/** Run fn with only the given variables set (from the list above). Restores the rest. */
function withEnv<T>(values: Record<string, string>, fn: () => T): T {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE = {
  SESSION_SECRET: "test-session-secret-32-bytes-minimum!!",
  POSTGRES_PASSWORD: "stub-not-a-real-password",
};

test("defaults stay local: loopback bind, local origin, local database", () => {
  withEnv(BASE, () => {
    const config = loadConfig();
    assert.equal(config.publicBaseUrl, "http://127.0.0.1:3000");
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.database.host, "127.0.0.1");
    assert.equal(config.database.database, "mcpencode");
    // Even on loopback, the first account needs the setup code.
    assert.notEqual(config.setupCodeRequired, false);
    assert.equal(config.trustProxy, undefined);
  });
});

test("PUBLIC_BASE_URL, PORT and BIND_HOST set the public address and listener", () => {
  withEnv({ ...BASE, PUBLIC_BASE_URL: "https://library.example.org/", PORT: "8080", BIND_HOST: "0.0.0.0" }, () => {
    const config = loadConfig();
    assert.equal(config.publicBaseUrl, "https://library.example.org");
    assert.equal(config.authIssuer, "https://library.example.org/id");
    assert.equal(config.port, 8080);
    assert.equal(config.bindHost, "0.0.0.0");
    assert.notEqual(config.setupCodeRequired, false);
  });
});

test("DATABASE_URL configures the database; POSTGRES_* override its parts", () => {
  withEnv(
    { DATABASE_URL: "postgresql://app:s3cret@db.example.internal:6543/library?sslmode=require" },
    () => {
      const db = loadDatabaseConfig();
      assert.equal(db.host, "db.example.internal");
      assert.equal(db.port, 6543);
      assert.equal(db.user, "app");
      assert.equal(db.database, "library");
      assert.equal(db.ssl, true);
    },
  );
  withEnv(
    {
      DATABASE_URL: "postgresql://app:s3cret@db.example.internal:6543/library",
      POSTGRES_HOST: "127.0.0.1",
      POSTGRES_DATABASE: "mcpencode",
    },
    () => {
      const db = loadDatabaseConfig();
      assert.equal(db.host, "127.0.0.1");
      assert.equal(db.database, "mcpencode");
      assert.equal(db.ssl, false);
    },
  );
});

test("a missing database password names the standard variables", () => {
  withEnv({}, () => {
    assert.throws(
      () => loadDatabaseConfig(),
      (error: Error) =>
        /password is missing/.test(error.message) &&
        /DATABASE_URL/.test(error.message) &&
        /POSTGRES_PASSWORD/.test(error.message),
    );
  });
});

test("OAUTH_REDIRECT_HOSTS defaults to none", () => {
  withEnv(BASE, () => assert.deepEqual(loadConfig().oauthRedirectHosts, []));
  withEnv({ ...BASE, OAUTH_REDIRECT_HOSTS: "claude.ai, www.perplexity.ai" }, () =>
    assert.deepEqual(loadConfig().oauthRedirectHosts, ["claude.ai", "www.perplexity.ai"]),
  );
});

test("removed settings are ignored with one warning each, never a crash", () => {
  const values = Object.fromEntries(REMOVED_ENV_VARS.map((name) => [name, name === "OAUTH_REFRESH_MAX_DAYS" ? "7" : "true"]));
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    withEnv({ ...BASE, ...values, OAUTH_LEGACY_CLIENT: "maybe" }, () => {
      const config = loadConfig();
      // The setup code stays required and limits keep their fixed values.
      assert.equal(config.setupCodeRequired, undefined);
      assert.equal(config.refreshMaxLifetimeDays, undefined);
    });
  } finally {
    console.warn = original;
  }
  for (const name of REMOVED_ENV_VARS) {
    assert.equal(warnings.filter((line) => line.startsWith(`${name} is no longer supported`)).length, 1, name);
  }
  assert.deepEqual(warnIgnoredEnv({}, () => assert.fail("no warning expected")), []);
});

test("fixed OAuth limits keep their previous defaults", () => {
  assert.deepEqual(OAUTH_LIMITS, {
    registerPerHour: 20,
    authorizePerMinute: 60,
    maxPendingClients: 1000,
    maxPendingClientsPerAddress: 20,
    pendingClientTtlMinutes: 60,
    refreshMaxDays: 30,
    passwordHashConcurrency: 2,
  });
});

test("TRUST_PROXY is off unless set, and never trusts every hop", () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(""), undefined);
  assert.equal(parseTrustProxy("false"), undefined);
  assert.equal(parseTrustProxy("0"), undefined);
  assert.equal(parseTrustProxy("1"), 1);
  assert.deepEqual(parseTrustProxy("loopback, uniquelocal"), ["loopback", "uniquelocal"]);
  assert.deepEqual(parseTrustProxy("10.0.0.0/8,::1"), ["10.0.0.0/8", "::1"]);
  assert.throws(() => parseTrustProxy("true"), /hop/);
  assert.throws(() => parseTrustProxy("everyone"));
  assert.throws(() => parseTrustProxy("99"));
  // A public bind alone no longer turns it on.
  withEnv({ ...BASE, BIND_HOST: "0.0.0.0" }, () => assert.equal(loadConfig().trustProxy, undefined));
  withEnv({ ...BASE, TRUST_PROXY: "1" }, () => assert.equal(loadConfig().trustProxy, 1));
});

test("AUTH_MCP_AUDIENCE: always required in oidc mode", () => {
  const oidc = { ...BASE, AUTH_MODE: "oidc", AUTH_ISSUER: "https://idp.example.org", AUTH_AUDIENCE: "web-project" };
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    withEnv({ ...oidc, AUTH_MCP_AUDIENCE: "mcp-project" }, () => {
      const config = loadConfig();
      assert.equal(config.authAudience, "web-project");
      assert.equal(config.authMcpAudience, "mcp-project");
    });
    assert.equal(warnings.some((line) => line.includes("AUTH_MCP_AUDIENCE")), false);
    withEnv(oidc, () => assert.throws(() => loadConfig(), /AUTH_MCP_AUDIENCE is required/));
    // The old escape hatch is ignored: still required.
    withEnv({ ...oidc, AUTH_MCP_AUDIENCE_SHARED: "true" }, () => assert.throws(() => loadConfig(), /AUTH_MCP_AUDIENCE is required/));
    warnings.length = 0;
    withEnv({ ...BASE, AUTH_MCP_AUDIENCE: "ignored" }, () => assert.equal(loadConfig().authMcpAudience, undefined));
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});

test("PUBLIC_BASE_URL: plain http only on loopback unless ALLOW_INSECURE_HTTP=true", () => {
  for (const ok of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "https://library.example.org"]) {
    withEnv({ ...BASE, PUBLIC_BASE_URL: ok }, () => assert.equal(loadConfig().publicBaseUrl, ok));
  }
  for (const bad of ["http://library.example.org", "http://10.0.0.5:3000", "http://192.168.1.10"]) {
    withEnv({ ...BASE, PUBLIC_BASE_URL: bad }, () => assert.throws(() => loadConfig(), /ALLOW_INSECURE_HTTP/));
    withEnv({ ...BASE, PUBLIC_BASE_URL: bad, ALLOW_INSECURE_HTTP: "true" }, () =>
      assert.equal(loadConfig().publicBaseUrl, bad),
    );
  }
  withEnv({ ...BASE, PUBLIC_BASE_URL: "ftp://library.example.org" }, () => assert.throws(() => loadConfig()));
});
