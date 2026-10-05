import { existsSync } from "node:fs";

/**
 * Runtime configuration. Values come from the environment so the same
 * process can sit behind Keycloak locally or any OAuth 2.1 issuer later.
 */
export type AuthMode = "embedded" | "oidc";

/** Postgres connection. The password is never logged. */
export type DatabaseConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** When true, the driver verifies the server certificate. */
  ssl: boolean;
};

export type AppConfig = {
  port: number;
  bindHost: string;
  /** Publisher origin. Library MCP URLs are `{publicBaseUrl}/libraries/{id}/mcp`. */
  publicBaseUrl: string;
  /** Extra Host header names (custom domains) beyond publicBaseUrl. */
  allowedHosts: string[];
  authMode: AuthMode;
  authIssuer: string;
  authJwksUrl: string;
  /** Audience for the web UI login token (not a library MCP link). */
  authAudience: string;
  webClientId: string;
  sessionSecret: string;
  database: DatabaseConfig;
};

const DB_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Database and user names are interpolated only after this check. */
export function assertDbIdentifier(value: string, label: string): string {
  if (!DB_IDENTIFIER.test(value)) {
    throw new Error(`${label} must use letters, digits, and underscores only`);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Railway sets RAILWAY_PUBLIC_DOMAIN to the public hostname, with no scheme.
 * Used when PUBLIC_BASE_URL was not typed in by hand.
 */
function railwayPublicOrigin(): string | undefined {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (!domain || domain.length > 253 || /[\s/]/.test(domain)) return undefined;
  return `https://${domain}`;
}

/** Comma-separated hostnames for Host / Origin checks (no scheme, no path). */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const hosts: string[] = [];
  for (const part of raw.split(",")) {
    const host = part.trim().toLowerCase();
    if (!host || host.length > 253 || /[\s/:?]/.test(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

/** True for hosts that stay on this machine (local Docker publishes 127.0.0.1). */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * Remote Postgres must use TLS unless the host is local, Railway's private
 * network, or an operator opts out (`POSTGRES_SSL=disable`).
 */
export function resolvePostgresSsl(host: string, sslEnv: string | undefined): boolean {
  const mode = sslEnv?.trim().toLowerCase();
  if (mode === "required") return true;
  if (mode === "disable") return false;
  if (isLoopbackHost(host)) return false;
  // Railway private DNS. The database is not on the public internet and does not present a cert.
  if (host.trim().toLowerCase().endsWith(".railway.internal")) return false;
  throw new Error(
    "POSTGRES_SSL must be set for a remote host: use POSTGRES_SSL=required (preferred) or POSTGRES_SSL=disable only on a trusted private network",
  );
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Railway's Postgres plugin publishes DATABASE_URL. POSTGRES_* still wins when set. */
export function parseDatabaseUrl(raw: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode?: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid Postgres URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must start with postgresql://");
  }
  const port = Number(url.port || "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_URL port must be an integer from 1 to 65535");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) {
    throw new Error("DATABASE_URL must include a host and database name");
  }
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    sslMode: url.searchParams.get("sslmode") ?? undefined,
  };
}

export function loadDatabaseConfig(): DatabaseConfig {
  const fromUrl = envValue("DATABASE_URL") ? parseDatabaseUrl(envValue("DATABASE_URL")!) : undefined;
  const portRaw = envValue("POSTGRES_PORT") || envValue("PGPORT") || (fromUrl ? String(fromUrl.port) : "5432");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("POSTGRES_PORT must be an integer from 1 to 65535");
  }
  const host = envValue("POSTGRES_HOST") || envValue("PGHOST") || fromUrl?.host || "127.0.0.1";
  if (!host || /\s/.test(host) || host.length > 253) {
    throw new Error("POSTGRES_HOST is invalid");
  }
  const user = assertDbIdentifier(
    envValue("POSTGRES_USER") || envValue("PGUSER") || fromUrl?.user || "mpos",
    "POSTGRES_USER",
  );
  const database = assertDbIdentifier(
    envValue("POSTGRES_DATABASE") || envValue("PGDATABASE") || fromUrl?.database || "mpos",
    "POSTGRES_DATABASE",
  );
  const password = envValue("POSTGRES_PASSWORD") || envValue("PGPASSWORD") || fromUrl?.password;
  if (!password) {
    throw new Error(
      "Missing database password. On the app service in Railway, add DATABASE_URL with value ${{Postgres.DATABASE_URL}} (use the Postgres service's real name). The app also accepts POSTGRES_PASSWORD or PGPASSWORD.",
    );
  }
  const sslEnv = envValue("POSTGRES_SSL") || (fromUrl?.sslMode === "require" ? "required" : fromUrl?.sslMode === "disable" ? "disable" : undefined);
  return {
    host,
    port,
    user,
    password,
    database,
    ssl: resolvePostgresSsl(host, sslEnv),
  };
}

export function loadConfig(): AppConfig {
  const origin = railwayPublicOrigin();
  // MCP_RESOURCE_URL used to be the global /mcp address. Accept its origin only.
  const legacyMcp = process.env.MCP_RESOURCE_URL?.trim();
  let legacyOrigin: string | undefined;
  if (legacyMcp) {
    try {
      legacyOrigin = new URL(legacyMcp).origin;
    } catch {
      legacyOrigin = undefined;
    }
  }
  const publicBaseUrl = (
    process.env.PUBLIC_BASE_URL?.trim() ||
    origin ||
    legacyOrigin ||
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  if (!publicBaseUrl) {
    throw new Error(
      "Missing PUBLIC_BASE_URL. On Railway, generate a public domain under Networking. Locally, set PUBLIC_BASE_URL.",
    );
  }
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT?.trim() || origin);
  const authMode: AuthMode = process.env.AUTH_MODE === "oidc" ? "oidc" : "embedded";
  const authIssuer = (
    authMode === "embedded"
      ? `${publicBaseUrl}/id`
      : process.env.AUTH_ISSUER?.trim() || ""
  ).replace(/\/$/, "");
  if (!authIssuer) {
    throw new Error("AUTH_ISSUER is required when AUTH_MODE=oidc");
  }
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  return {
    port: Number(process.env.PORT ?? "3000"),
    bindHost: process.env.BIND_HOST?.trim() || (onRailway ? "0.0.0.0" : "127.0.0.1"),
    publicBaseUrl,
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
    authMode,
    authIssuer,
    authJwksUrl:
      process.env.AUTH_JWKS_URL?.trim() ||
      (authMode === "embedded"
        ? `${authIssuer}/jwks`
        : `${authIssuer}/protocol/openid-connect/certs`),
    authAudience: process.env.AUTH_AUDIENCE?.trim() || publicBaseUrl,
    webClientId: process.env.WEB_CLIENT_ID ?? "mpos-web",
    sessionSecret,
    database: loadDatabaseConfig(),
  };
}

/** True when a leftover SQLite file is still on disk. The app does not read it. */
export function legacySqliteFilePresent(): boolean {
  return existsSync("./data/mpos.db");
}
