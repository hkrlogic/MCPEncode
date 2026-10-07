import { existsSync } from "node:fs";

/**
 * Runtime configuration. Leave AUTH_MODE unset to use the built-in accounts.
 * AUTH_MODE=oidc points at an external issuer instead.
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

/** Percent-decoding is optional. A raw password may contain a lone %. */
function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type ParsedDatabaseUrl = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode?: string;
};

/**
 * Read a Postgres URL without the WHATWG parser. Passwords from Railway can
 * contain characters that parser treats as the end of the address.
 * Host or database may be blank; the caller fills those from other variables.
 */
export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  const trimmed = raw.trim();
  const scheme = /^(postgres(?:ql)?):\/\//i.exec(trimmed);
  if (!scheme) {
    throw new Error("DATABASE_URL must start with postgresql://");
  }
  let rest = trimmed.slice(scheme[0].length);
  const queryAt = rest.indexOf("?");
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  if (queryAt !== -1) rest = rest.slice(0, queryAt);
  const at = rest.lastIndexOf("@");
  const userinfo = at === -1 ? "" : rest.slice(0, at);
  const hostAndDb = at === -1 ? rest : rest.slice(at + 1);
  const slash = hostAndDb.indexOf("/");
  const hostport = slash === -1 ? hostAndDb : hostAndDb.slice(0, slash);
  const database = decodeUserinfo(slash === -1 ? "" : hostAndDb.slice(slash + 1));
  let host = hostport;
  let port = 5432;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) throw new Error("DATABASE_URL host is invalid");
    const after = host.slice(end + 1);
    host = host.slice(1, end);
    if (after.startsWith(":")) port = Number(after.slice(1));
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
      port = Number(host.slice(colon + 1));
      host = host.slice(0, colon);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_URL port must be an integer from 1 to 65535");
  }
  const sep = userinfo.indexOf(":");
  const user = decodeUserinfo(sep === -1 ? userinfo : userinfo.slice(0, sep));
  const password = decodeUserinfo(sep === -1 ? "" : userinfo.slice(sep + 1));
  const sslMode = new URLSearchParams(query).get("sslmode") ?? undefined;
  return { host, port, user, password, database, sslMode };
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function onRailway(): boolean {
  return Boolean(
    envValue("RAILWAY_ENVIRONMENT") || envValue("RAILWAY_PROJECT_ID") || envValue("RAILWAY_SERVICE_ID"),
  );
}

function railwayDatabaseHelp(): string {
  return (
    "On the app service, add five variables and pick each value from the Postgres service: " +
    "POSTGRES_HOST=${{Postgres.PGHOST}}, POSTGRES_PORT=${{Postgres.PGPORT}}, " +
    "POSTGRES_USER=${{Postgres.PGUSER}}, POSTGRES_PASSWORD=${{Postgres.PGPASSWORD}}, " +
    "POSTGRES_DATABASE=${{Postgres.PGDATABASE}}. " +
    "Use the service's real name if it is not Postgres. Delete DATABASE_URL if it is not a full postgresql://user:password@host:port/database address."
  );
}

export function loadDatabaseConfig(): DatabaseConfig {
  const rawUrl = envValue("DATABASE_URL");
  // A pasted ${{Postgres.DATABASE_URL}} that Railway did not fill in is not a connection.
  const fromUrl = rawUrl && !rawUrl.includes("${{") ? parseDatabaseUrl(rawUrl) : undefined;
  const portRaw = firstDefined(envValue("POSTGRES_PORT"), envValue("PGPORT"), fromUrl ? String(fromUrl.port) : undefined) ?? "5432";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("POSTGRES_PORT must be an integer from 1 to 65535");
  }
  const railway = onRailway();
  const host =
    firstDefined(envValue("POSTGRES_HOST"), envValue("PGHOST"), fromUrl?.host) || (railway ? "" : "127.0.0.1");
  if (!host || /\s/.test(host) || host.length > 253 || host.includes("${{")) {
    throw new Error(`Database host is missing. ${railwayDatabaseHelp()}`);
  }
  const user = assertDbIdentifier(
    firstDefined(envValue("POSTGRES_USER"), envValue("PGUSER"), fromUrl?.user) || "mpos",
    "POSTGRES_USER",
  );
  // Railway's Postgres image creates a database named railway. A URL with no path still means that.
  const databaseName =
    firstDefined(envValue("POSTGRES_DATABASE"), envValue("PGDATABASE"), envValue("POSTGRES_DB"), fromUrl?.database) ||
    (railway || host.toLowerCase().endsWith(".railway.internal") ? "railway" : "mpos");
  const database = assertDbIdentifier(databaseName, "POSTGRES_DATABASE");
  const password = firstDefined(envValue("POSTGRES_PASSWORD"), envValue("PGPASSWORD"), fromUrl?.password);
  if (!password) {
    throw new Error(`Database password is missing. ${railwayDatabaseHelp()}`);
  }
  const sslEnv =
    envValue("POSTGRES_SSL") ||
    (fromUrl?.sslMode === "require" ? "required" : fromUrl?.sslMode === "disable" ? "disable" : undefined);
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
