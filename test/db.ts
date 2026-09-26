import "dotenv/config";
import { randomBytes } from "node:crypto";
import mariadb, { type Connection } from "mariadb";
import { assertDbIdentifier, loadDatabaseConfig, type DatabaseConfig } from "../src/config.ts";
import { openDatabase, resetDatabaseCache } from "../src/db/client.ts";
import type { Database } from "../src/db/types.ts";

const TEST_DATABASE = /^mpos_test_[a-f0-9]{16}$/;

function adminPassword(): string {
  const password =
    process.env.MARIADB_ROOT_PASSWORD?.trim() || process.env.MARIADB_ADMIN_PASSWORD?.trim() || "";
  if (!password) {
    throw new Error("Set MARIADB_ROOT_PASSWORD so tests can create a throwaway database");
  }
  return password;
}

function assertTestDatabase(name: string): void {
  if (!TEST_DATABASE.test(name)) {
    throw new Error("Refusing to create or drop a database that is not a throwaway test database");
  }
}

async function withAdmin<T>(
  config: DatabaseConfig,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const conn = await mariadb.createConnection({
    host: config.host,
    port: config.port,
    user: process.env.MARIADB_ADMIN_USER?.trim() || "root",
    password: adminPassword(),
    connectTimeout: 10_000,
    permitLocalInfile: false,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
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
  assertDbIdentifier(base.user, "MARIADB_USER");
  const config: DatabaseConfig = { ...base, database };
  let created = false;
  await withAdmin(config, async (conn) => {
    await conn.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    created = true;
    await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${base.user}'@'%'`);
    await conn.query("FLUSH PRIVILEGES");
  });
  return {
    config,
    cleanup: async () => {
      resetDatabaseCache();
      if (!created) return;
      await withAdmin(config, async (conn) => {
        await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
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
