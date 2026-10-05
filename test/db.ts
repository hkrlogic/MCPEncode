import "dotenv/config";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { assertDbIdentifier, loadDatabaseConfig, type DatabaseConfig } from "../src/config.ts";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import type { Database } from "../src/db/types.ts";

const { Client } = pg;

const TEST_DATABASE = /^mpos_test_[a-f0-9]{16}$/;

function adminPassword(): string {
  const password =
    process.env.POSTGRES_ADMIN_PASSWORD?.trim() || process.env.POSTGRES_PASSWORD?.trim() || "";
  if (!password) {
    throw new Error("Set POSTGRES_PASSWORD so tests can create a throwaway database");
  }
  return password;
}

function assertTestDatabase(name: string): void {
  if (!TEST_DATABASE.test(name)) {
    throw new Error("Refusing to create or drop a database that is not a throwaway test database");
  }
}

async function withAdmin<T>(config: DatabaseConfig, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: process.env.POSTGRES_ADMIN_USER?.trim() || config.user,
    password: adminPassword(),
    database: "postgres",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A private database for one test. Dropped when cleanup runs. */
export async function disposableDatabase(): Promise<{
  config: DatabaseConfig;
  cleanup: () => Promise<void>;
}> {
  const base = loadDatabaseConfig();
  const database = `mpos_test_${randomBytes(8).toString("hex")}`;
  assertTestDatabase(database);
  assertDbIdentifier(base.user, "POSTGRES_USER");
  const config: DatabaseConfig = { ...base, database };
  let created = false;
  await withAdmin(config, async (client) => {
    await client.query(`CREATE DATABASE "${database}" OWNER "${base.user}"`);
    created = true;
  });
  return {
    config,
    cleanup: async () => {
      resetDatabaseCache();
      if (!created) return;
      await withAdmin(config, async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await client.query(`DROP DATABASE IF EXISTS "${database}"`);
      });
    },
  };
}

/** Open a migrated database, run the test, then drop the database. */
export async function withTestDatabase(run: (db: Database) => Promise<void>): Promise<void> {
  const { config, cleanup } = await disposableDatabase();
  resetDatabaseCache();
  let db: Database | undefined;
  try {
    db = await openDatabase(config);
    await run(db);
  } finally {
    await db?.close();
    resetDatabaseCache();
    await cleanup();
  }
}
