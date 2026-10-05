import pg from "pg";
import type { DatabaseConfig } from "../config.ts";
import { applyMigrations } from "./migrate.ts";
import { assertNoDropTable, splitSql } from "./sql.ts";
import type { Database } from "./types.ts";

const { Pool, types } = pg;

// Timestamps and COUNT(*) are BIGINT. node-pg returns those as strings by default.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

/**
 * One pool for the process. Tests call close() and resetDatabaseCache()
 * before opening a different database.
 */
let cached: { key: string; db: Database } | undefined;

type SqlError = {
  code?: string;
  message?: string;
};

/**
 * Bind positionals for node-postgres.
 * Call sites keep `?` placeholders; this rewrites them to `$1…$n`.
 */
export function toPgParams(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

/**
 * Open the Postgres pool and apply migrations.
 * Pass { migrate: false } only to plant a schema in tests.
 * The database itself is created by Docker Compose (or by you).
 * The app user is not required to create or drop databases.
 */
export async function openDatabase(
  config: DatabaseConfig,
  options: { migrate?: boolean } = {},
): Promise<Database> {
  const migrate = options.migrate !== false;
  const key = `${config.host}:${config.port}/${config.database}/${config.user}/${migrate}`;
  if (cached?.key === key) return cached.db;
  if (cached) {
    throw new Error("Close the open Postgres pool before opening another database");
  }

  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    application_name: "mcpencode",
    // Small pool: this app is request/MCP tool traffic, not a bulk ETL worker.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Cap runaway lookups / accidental full scans. Values are Postgres GUCs.
    options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000",
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
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

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<pg.QueryResult>;
};

function createDatabase(queryable: Queryable, close?: () => Promise<void>): Database {
  async function query(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    const text = params.length === 0 ? sql : toPgParams(sql);
    return queryable.query(text, params.length === 0 ? undefined : params);
  }

  const db: Database = {
    async exec(sql: string): Promise<void> {
      for (const statement of splitSql(sql)) {
        assertNoDropTable(statement);
        await query(statement, []);
      }
    },
    async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
      const result = await query(sql, params);
      return result.rows.map(plainRow);
    },
    async get(sql: string, ...params: unknown[]): Promise<unknown> {
      const result = await query(sql, params);
      return result.rows[0] ? plainRow(result.rows[0]) : undefined;
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
      if (!(queryable instanceof Pool)) {
        throw new Error("Nested transactions are not used");
      }
      const client = await queryable.connect();
      const tx = createDatabase(client);
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (!close) throw new Error("This connection is closed by the pool");
      await close();
    },
  };
  return db;
}

/** Copy the row so callers never hold the driver’s mutable result object. */
function plainRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  return { ...row };
}

function explainConnectionError(error: unknown, config: DatabaseConfig): Error {
  const err = (error ?? {}) as SqlError;
  const message = err.message ?? "Postgres error";
  if (err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
    return new Error(
      `Cannot reach Postgres at ${config.host}:${config.port}. Start it with: docker compose up -d postgres`,
    );
  }
  if (err.code === "3D000") {
    return new Error(
      `Postgres database "${config.database}" does not exist. docker compose up -d postgres creates it.`,
    );
  }
  if (err.code === "28P01") {
    return new Error(
      `Postgres rejected user "${config.user}" at ${config.host}:${config.port}. Check POSTGRES_USER and POSTGRES_PASSWORD.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}
