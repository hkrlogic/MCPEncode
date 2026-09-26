import mariadb from "mariadb";
import type { DatabaseConfig } from "../config.ts";
import { applyMigrations } from "./migrate.ts";
import { assertNoDropTable, splitSql } from "./sql.ts";
import type { Database } from "./types.ts";

/**
 * One pool for the process. Tests call close() and resetDatabaseCache()
 * before opening a different database.
 */
let cached: { key: string; db: Database } | undefined;

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

type SqlError = {
  code?: string;
  errno?: number;
  message?: string;
};

/**
 * Open the MariaDB pool and apply migrations.
 * Pass { migrate: false } only to plant an older schema in tests.
 * The database itself is created by Docker Compose (or by you, on your own server).
 * The app user is not granted permission to create or drop databases.
 */
export async function openDatabase(
  config: DatabaseConfig,
  options: { migrate?: boolean } = {},
): Promise<Database> {
  const migrate = options.migrate !== false;
  const key = `${config.host}:${config.port}/${config.database}/${config.user}/${migrate}`;
  if (cached?.key === key) return cached.db;
  if (cached) {
    throw new Error("Close the open MariaDB pool before opening another database");
  }

  const pool = mariadb.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 10,
    connectTimeout: 10_000,
    charset: "utf8mb4",
    bigIntAsNumber: true,
    // LOAD DATA LOCAL can read server files. Leave it off.
    permitLocalInfile: false,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    multipleStatements: false,
  });

  const db = createDatabase(pool, async () => {
    await pool.end();
    if (cached?.key === key) cached = undefined;
  });

  try {
    await db.get("SELECT 1 AS ok");
  } catch (error) {
    await pool.end();
    throw explainConnectionError(error, config);
  }

  try {
    if (migrate) await applyMigrations(db);
  } catch (error) {
    await pool.end();
    throw error;
  }

  cached = { key, db };
  return db;
}

/** Test helper: drop the cached pool handle. Call close() first. */
export function resetDatabaseCache(): void {
  cached = undefined;
}

function createDatabase(queryable: Queryable, close?: () => Promise<void>): Database {
  async function query(sql: string, params: unknown[]): Promise<unknown> {
    // The driver binds parameters. Values are never concatenated into SQL.
    if (params.length === 0) return queryable.query(sql);
    return queryable.query(sql, params);
  }

  const db: Database = {
    async exec(sql: string): Promise<void> {
      for (const statement of splitSql(sql)) {
        assertNoDropTable(statement);
        await query(statement, []);
      }
    },
    async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
      return asRows(await query(sql, params));
    },
    async get(sql: string, ...params: unknown[]): Promise<unknown> {
      return asRows(await query(sql, params))[0];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      await query(sql, params);
    },
    prepare(sql: string) {
      return Promise.resolve({
        all: (...params: unknown[]) => db.all(sql, ...params),
        get: (...params: unknown[]) => db.get(sql, ...params),
        run: (...params: unknown[]) => db.run(sql, ...params),
      });
    },
    async transaction(fn) {
      if (!isPool(queryable)) {
        throw new Error("Nested transactions are not used");
      }
      const conn = await queryable.getConnection();
      const tx = createDatabase(conn);
      try {
        await conn.beginTransaction();
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    },
    async close() {
      if (!close) throw new Error("This connection is closed by the pool");
      await close();
    },
  };
  return db;
}

function isPool(value: Queryable): value is Queryable & {
  getConnection(): Promise<Queryable & {
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
  }>;
} {
  return "getConnection" in value && typeof value.getConnection === "function";
}

function asRows(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return result.map(plainRow);
}

/** BIGINT may arrive as bigint. Column names stay as the driver returns them. */
function plainRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

function explainConnectionError(error: unknown, config: DatabaseConfig): Error {
  const err = (error ?? {}) as SqlError;
  const message = err.message ?? "MariaDB error";
  if (err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
    return new Error(
      `Cannot reach MariaDB at ${config.host}:${config.port}. Start it with: docker compose up -d mariadb`,
    );
  }
  if (err.errno === 1049 || err.code === "ER_BAD_DB_ERROR") {
    return new Error(
      `MariaDB database "${config.database}" does not exist. docker compose up -d mariadb creates it. On your own server, create the database and grant the app user access.`,
    );
  }
  if (err.errno === 1045 || err.code === "ER_ACCESS_DENIED_ERROR") {
    return new Error(
      `MariaDB rejected user "${config.user}" at ${config.host}:${config.port}. Check MARIADB_USER and MARIADB_PASSWORD.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}
