import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDatabaseConfig } from "../src/config.ts";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";

test("a wrong database password names the setting and does not assume Docker", async () => {
  const config = { ...loadDatabaseConfig(), password: "wrong-password-for-this-test" };
  resetDatabaseCache();
  await assert.rejects(openDatabase(config, { migrate: false }), (error: Error) => {
    assert.match(error.message, /rejected the password for user/);
    assert.match(error.message, /POSTGRES_PASSWORD/);
    // Docker is one possible cause, not the assumed setup.
    assert.match(error.message, /One possible cause with Docker Compose/);
    return true;
  });
  resetDatabaseCache();
});

test("a dropped idle connection does not crash the process", async () => {
  const { disposableDatabase } = await import("./db.ts");
  const { config, cleanup } = await disposableDatabase();
  resetDatabaseCache();
  const db = await openDatabase(config, { migrate: false });
  const originalError = console.error;
  console.error = () => {};
  try {
    const pid = ((await db.get("SELECT pg_backend_pid() AS pid")) as { pid: number }).pid;
    // Terminate the pooled (now idle) connection from another session, as a Postgres restart would.
    const pg = (await import("pg")).default;
    const admin = new pg.Client({ ...config, ssl: undefined });
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await admin.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still alive, and the pool reconnects.
    assert.deepEqual(await db.get("SELECT 1 AS ok"), { ok: 1 });
  } finally {
    console.error = originalError;
    await db.close();
    await cleanup();
  }
});
