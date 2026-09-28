import { existsSync } from "node:fs";

/**
 * Runtime configuration. Values come from the environment so the same
 * process can sit behind Keycloak locally or any OAuth 2.1 issuer later.
 */
export type AuthMode = "embedded" | "oidc";

/** MariaDB connection. The password is never logged. */
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
  mcpResourceUrl: string;
  publicBaseUrl: string;
  authMode: AuthMode;
  authIssuer: string;
  authJwksUrl: string;
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
 * Used when MCP_RESOURCE_URL and PUBLIC_BASE_URL were not typed in by hand.
 */
function railwayPublicOrigin(): string | undefined {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (!domain || domain.length > 253 || /[\s/]/.test(domain)) return undefined;
  return `https://${domain}`;
}

export function loadDatabaseConfig(): DatabaseConfig {
  const port = Number(process.env.MARIADB_PORT ?? "3306");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MARIADB_PORT must be an integer from 1 to 65535");
  }
  const host = process.env.MARIADB_HOST?.trim() || "127.0.0.1";
  if (!host || /\s/.test(host) || host.length > 253) {
    throw new Error("MARIADB_HOST is invalid");
  }
  const user = assertDbIdentifier(process.env.MARIADB_USER?.trim() || "mpos", "MARIADB_USER");
  const database = assertDbIdentifier(
    process.env.MARIADB_DATABASE?.trim() || "mpos",
    "MARIADB_DATABASE",
  );
  return {
    host,
    port,
    user,
    password: required("MARIADB_PASSWORD"),
    database,
    ssl: process.env.MARIADB_SSL?.trim().toLowerCase() === "required",
  };
}

export function loadConfig(): AppConfig {
  const origin = railwayPublicOrigin();
  const mcpResourceUrl = (process.env.MCP_RESOURCE_URL?.trim() || (origin ? `${origin}/mcp` : "")).replace(
    /\/$/,
    "",
  );
  if (!mcpResourceUrl) {
    throw new Error(
      "Missing MCP_RESOURCE_URL. On Railway, generate a public domain under Networking. Locally, set MCP_RESOURCE_URL.",
    );
  }
  const publicBaseUrl = (
    process.env.PUBLIC_BASE_URL?.trim() ||
    origin ||
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
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
    mcpResourceUrl,
    publicBaseUrl,
    authMode,
    authIssuer,
    authJwksUrl:
      process.env.AUTH_JWKS_URL?.trim() ||
      (authMode === "embedded"
        ? `${authIssuer}/jwks`
        : `${authIssuer}/protocol/openid-connect/certs`),
    authAudience: process.env.AUTH_AUDIENCE?.trim() || mcpResourceUrl,
    webClientId: process.env.WEB_CLIENT_ID ?? "mpos-web",
    sessionSecret,
    database: loadDatabaseConfig(),
  };
}

/** True when a leftover SQLite file is still on disk. The app does not read it. */
export function legacySqliteFilePresent(): boolean {
  return existsSync("./data/mpos.db");
}
