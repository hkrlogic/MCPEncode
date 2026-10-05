import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackHost, loadDatabaseConfig, parseDatabaseUrl, resolvePostgresSsl } from "../src/config.ts";
import { toPgParams } from "../src/db/client.ts";
import { assertNoDropTable, splitSql } from "../src/db/sql.ts";

test("migration splitter ignores semicolons in comments and strings", () => {
  const parts = splitSql(`
    -- DROP TABLE records;
    SELECT 'a;b';
    /* ; */
    SELECT 1;
  `);
  assert.deepEqual(parts, ["SELECT 'a;b'", "SELECT 1"]);
});

test("drop table is rejected", () => {
  assert.throws(() => assertNoDropTable("DROP TABLE records"), /records is kept/);
  assert.throws(() => assertNoDropTable("drop table if exists items"), /records is kept/);
});

test("toPgParams rewrites ? placeholders to $n", () => {
  assert.equal(toPgParams("SELECT 1"), "SELECT 1");
  assert.equal(toPgParams("SELECT * FROM items WHERE id = ?"), "SELECT * FROM items WHERE id = $1");
  assert.equal(
    toPgParams("INSERT INTO t (a, b) VALUES (?, ?::jsonb)"),
    "INSERT INTO t (a, b) VALUES ($1, $2::jsonb)",
  );
});

test("remote Postgres requires an explicit SSL choice", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(resolvePostgresSsl("127.0.0.1", undefined), false);
  assert.equal(resolvePostgresSsl("db.example.com", "required"), true);
  assert.equal(resolvePostgresSsl("db.example.com", "disable"), false);
  assert.throws(() => resolvePostgresSsl("db.example.com", undefined), /POSTGRES_SSL/);
  assert.equal(resolvePostgresSsl("postgres.railway.internal", undefined), false);
});

test("DATABASE_URL supplies the Railway private connection", () => {
  const parsed = parseDatabaseUrl(
    "postgresql://postgres:s3cret%2Fpw@postgres.railway.internal:5432/railway",
  );
  assert.equal(parsed.host, "postgres.railway.internal");
  assert.equal(parsed.port, 5432);
  assert.equal(parsed.user, "postgres");
  assert.equal(parsed.password, "s3cret/pw");
  assert.equal(parsed.database, "railway");
});

test("DATABASE_URL keeps a password that contains a slash", () => {
  const parsed = parseDatabaseUrl("postgresql://postgres:sec/ret@postgres.railway.internal:5432");
  assert.equal(parsed.password, "sec/ret");
  assert.equal(parsed.host, "postgres.railway.internal");
  assert.equal(parsed.database, "");
});

test("a Railway URL with no database name uses the platform default", () => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    PGHOST: process.env.PGHOST,
    POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
    PGDATABASE: process.env.PGDATABASE,
    POSTGRES_DB: process.env.POSTGRES_DB,
    POSTGRES_USER: process.env.POSTGRES_USER,
    PGUSER: process.env.PGUSER,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
    PGPASSWORD: process.env.PGPASSWORD,
    POSTGRES_PORT: process.env.POSTGRES_PORT,
    PGPORT: process.env.PGPORT,
    POSTGRES_SSL: process.env.POSTGRES_SSL,
  };
  process.env.DATABASE_URL = "postgresql://postgres:s3cret@postgres.railway.internal:5432";
  delete process.env.RAILWAY_ENVIRONMENT;
  for (const key of [
    "POSTGRES_HOST",
    "PGHOST",
    "POSTGRES_DATABASE",
    "PGDATABASE",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "PGUSER",
    "POSTGRES_PASSWORD",
    "PGPASSWORD",
    "POSTGRES_PORT",
    "PGPORT",
    "POSTGRES_SSL",
  ]) {
    delete process.env[key];
  }
  try {
    const config = loadDatabaseConfig();
    assert.equal(config.host, "postgres.railway.internal");
    assert.equal(config.database, "railway");
    assert.equal(config.user, "postgres");
    assert.equal(config.password, "s3cret");
    assert.equal(config.ssl, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
