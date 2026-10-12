/**
 * Configuration comes only from documented env vars (PUBLIC_BASE_URL, PORT,
 * BIND_HOST, DATABASE_URL / POSTGRES_*). Nothing is inferred from the host platform.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, loadDatabaseConfig, parseTrustProxy } from "../src/config.ts";

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
  "OAUTH_ALLOW_ANY_HTTPS_REDIRECT",
  "OAUTH_LEGACY_CLIENT",
  "OAUTH_REFRESH_MAX_DAYS",
  "ALLOW_OPEN_SETUP",
  "TRUST_PROXY",
  "PASSWORD_HASH_CONCURRENCY",
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
    assert.equal(config.database.database, "mpos");
    // Even on loopback, the first account needs the setup code.
    assert.equal(config.setupCodeRequired, true);
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
    assert.equal(config.setupCodeRequired, true);
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
      POSTGRES_DATABASE: "mpos",
    },
    () => {
      const db = loadDatabaseConfig();
      assert.equal(db.host, "127.0.0.1");
      assert.equal(db.database, "mpos");
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

test("OAuth callback and refresh settings default to the safe choice", () => {
  withEnv(BASE, () => {
    const config = loadConfig();
    assert.deepEqual(config.oauthRedirectHosts, []);
    assert.equal(config.oauthAllowAnyHttpsRedirect, false);
    assert.equal(config.oauthLegacyClient, true);
    assert.equal(config.refreshMaxLifetimeDays, 30);
  });
  withEnv(
    {
      ...BASE,
      OAUTH_REDIRECT_HOSTS: "claude.ai, www.perplexity.ai",
      OAUTH_ALLOW_ANY_HTTPS_REDIRECT: "true",
      OAUTH_LEGACY_CLIENT: "false",
      OAUTH_REFRESH_MAX_DAYS: "7",
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.oauthRedirectHosts, ["claude.ai", "www.perplexity.ai"]);
      assert.equal(config.oauthAllowAnyHttpsRedirect, true);
      assert.equal(config.oauthLegacyClient, false);
      assert.equal(config.refreshMaxLifetimeDays, 7);
    },
  );
  const bad: Record<string, string>[] = [
    { OAUTH_REFRESH_MAX_DAYS: "0" },
    { OAUTH_REFRESH_MAX_DAYS: "1.5" },
    { OAUTH_LEGACY_CLIENT: "maybe" },
  ];
  for (const values of bad) {
    withEnv({ ...BASE, ...values }, () => assert.throws(() => loadConfig()));
  }
});

test("ALLOW_OPEN_SETUP=true is the only way to skip the setup code", () => {
  withEnv({ ...BASE, ALLOW_OPEN_SETUP: "true" }, () => assert.equal(loadConfig().setupCodeRequired, false));
  withEnv({ ...BASE, ALLOW_OPEN_SETUP: "false" }, () => assert.equal(loadConfig().setupCodeRequired, true));
  withEnv({ ...BASE, PUBLIC_BASE_URL: "https://library.example.org" }, () =>
    assert.equal(loadConfig().setupCodeRequired, true),
  );
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

test("PASSWORD_HASH_CONCURRENCY defaults to 2 and must be small", () => {
  withEnv(BASE, () => assert.equal(loadConfig().passwordHashConcurrency, 2));
  withEnv({ ...BASE, PASSWORD_HASH_CONCURRENCY: "4" }, () => assert.equal(loadConfig().passwordHashConcurrency, 4));
  for (const bad of ["0", "17", "two", "1.5"]) {
    withEnv({ ...BASE, PASSWORD_HASH_CONCURRENCY: bad }, () => assert.throws(() => loadConfig(), /PASSWORD_HASH_CONCURRENCY/));
  }
});
