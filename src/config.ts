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
 * Remote Postgres must use TLS unless an operator explicitly opts out on a
 * trusted private network (`POSTGRES_SSL=disable`).
 */
export function resolvePostgresSsl(host: string, sslEnv: string | undefined): boolean {
  const mode = sslEnv?.trim().toLowerCase();
  if (mode === "required") return true;
  if (mode === "disable") return false;
  if (isLoopbackHost(host)) return false;
  throw new Error(
    "POSTGRES_SSL must be set for a remote host: use POSTGRES_SSL=required (preferred) or POSTGRES_SSL=disable only on a trusted private network",
  );
}

export function loadDatabaseConfig(): DatabaseConfig {
  const port = Number(process.env.POSTGRES_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("POSTGRES_PORT must be an integer from 1 to 65535");
  }
  const host = process.env.POSTGRES_HOST?.trim() || "127.0.0.1";
  if (!host || /\s/.test(host) || host.length > 253) {
    throw new Error("POSTGRES_HOST is invalid");
  }
  const user = assertDbIdentifier(process.env.POSTGRES_USER?.trim() || "mpos", "POSTGRES_USER");
  const database = assertDbIdentifier(
    process.env.POSTGRES_DATABASE?.trim() || "mpos",
    "POSTGRES_DATABASE",
  );
  return {
    host,
    port,
    user,
    password: required("POSTGRES_PASSWORD"),
    database,
    ssl: resolvePostgresSsl(host, process.env.POSTGRES_SSL),
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
