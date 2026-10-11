import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { loadDatabaseConfig, parseConnectTimeoutSeconds } from "../src/config.ts";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import { isRetryableConnectionError, retryConnection } from "../src/db/connect-retry.ts";

function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}

/** Run fn with console.error silenced (retry log lines). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test("connection-level errors are retryable; auth and config errors are not", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "57P03"]) {
    assert.equal(isRetryableConnectionError(codeError(code)), true, code);
  }
  assert.equal(isRetryableConnectionError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isRetryableConnectionError(new Error("the database system is starting up")), true);
  // Wrong password, missing database, missing role: Postgres answered and said no.
  for (const code of ["28P01", "3D000", "28000"]) {
    assert.equal(isRetryableConnectionError(codeError(code)), false, code);
  }
  assert.equal(isRetryableConnectionError(new Error("POSTGRES_SSL must be set for a remote host")), false);
});

test("retry succeeds after transient failures, with a capped exponential backoff", async () => {
  const clock = fakeClock();
  const failures = [codeError("ENOTFOUND"), codeError("ECONNREFUSED"), codeError("57P03"), codeError("ECONNREFUSED")];
  const retries: number[] = [];
  let calls = 0;
  const result = await retryConnection(
    async () => {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return "ok";
    },
    {
      timeoutMs: 60_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      sleep: clock.sleep,
      now: clock.now,
      onRetry: ({ attempt }) => retries.push(attempt),
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 5);
  assert.deepEqual(retries, [1, 2, 3, 4]);
  assert.deepEqual(clock.waits, [500, 1_000, 2_000, 2_000]);
});

test("retry gives up after the timeout and rethrows the last connection error", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryConnection(
      async () => {
        calls += 1;
        throw codeError("ECONNREFUSED");
      },
      { timeoutMs: 10_000, initialDelayMs: 500, maxDelayMs: 4_000, sleep: clock.sleep, now: clock.now },
    ),
    { code: "ECONNREFUSED" },
  );
  // 500 + 1000 + 2000 + 4000 + 2500 (the rest of the window) = 10s, then one last attempt.
  assert.deepEqual(clock.waits, [500, 1_000, 2_000, 4_000, 2_500]);
  assert.equal(calls, 6);
  assert.equal(clock.now(), 10_000);
});

test("an attempt still hanging when the window closes counts as a timeout", async () => {
  const started = Date.now();
  await assert.rejects(
    retryConnection(() => new Promise<never>(() => {}), { timeoutMs: 200 }),
    { code: "ETIMEDOUT" },
  );
  assert.ok(Date.now() - started < 2_000);
});

test("retry does not retry an auth error", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryConnection(
      async () => {
        calls += 1;
        throw codeError("28P01", "password authentication failed");
      },
      { timeoutMs: 60_000, sleep: clock.sleep, now: clock.now },
    ),
    { code: "28P01" },
  );
  assert.equal(calls, 1);
  assert.deepEqual(clock.waits, []);
});

test("a timeout of 0 tries once", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryConnection(
      async () => {
        calls += 1;
        throw codeError("ECONNREFUSED");
      },
      { timeoutMs: 0, sleep: clock.sleep, now: clock.now },
    ),
  );
  assert.equal(calls, 1);
});

test("POSTGRES_CONNECT_TIMEOUT_SECONDS defaults to 60 and rejects junk", () => {
  assert.equal(parseConnectTimeoutSeconds(undefined), 60);
  assert.equal(parseConnectTimeoutSeconds("0"), 0);
  assert.equal(parseConnectTimeoutSeconds("15"), 15);
  for (const bad of ["-1", "1.5", "abc", "99999"]) {
    assert.throws(() => parseConnectTimeoutSeconds(bad), /POSTGRES_CONNECT_TIMEOUT_SECONDS/, bad);
  }
});

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("openDatabase gives up on an unreachable server after the timeout with the clear message", async () => {
  const port = await closedPort();
  const config = { ...loadDatabaseConfig(), host: "127.0.0.1", port, ssl: false, connectTimeoutSeconds: 2 };
  resetDatabaseCache();
  const started = Date.now();
  await quiet(() =>
    assert.rejects(openDatabase(config, { migrate: false }), (error: Error) => {
      assert.match(error.message, new RegExp(`Cannot reach Postgres at 127\\.0\\.0\\.1:${port}`));
      assert.match(error.message, /Gave up after 2s \(POSTGRES_CONNECT_TIMEOUT_SECONDS\)/);
      assert.doesNotMatch(error.message, new RegExp(config.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1_900 && elapsed < 6_000, `elapsed ${elapsed}ms`);
  resetDatabaseCache();
});

test("openDatabase fails fast on a wrong password even with a long retry window", async () => {
  const config = { ...loadDatabaseConfig(), password: "wrong-password-for-this-test", connectTimeoutSeconds: 60 };
  resetDatabaseCache();
  const started = Date.now();
  await quiet(() =>
    assert.rejects(openDatabase(config, { migrate: false }), /rejected the password for user/),
  );
  assert.ok(Date.now() - started < 5_000);
  resetDatabaseCache();
});
