import { existsSync } from "node:fs";
import { SETUP_TOKEN_MIN_LENGTH } from "./auth/setup-code.ts";

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
  /** POSTGRES_CONNECT_TIMEOUT_SECONDS: how long startup retries an unreachable server. Unset or 0 tries once. */
  connectTimeoutSeconds?: number;
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
  /**
   * AUTH_MCP_AUDIENCE (oidc mode): the audience library MCP tokens must carry,
   * kept apart from AUTH_AUDIENCE so a token for the web app cannot open MCP
   * and the other way round. Unset: AUTH_AUDIENCE, with a warning.
   * Embedded mode ignores it; each library link is its own audience.
   */
  authMcpAudience?: string;
  webClientId: string;
  sessionSecret: string;
  database: DatabaseConfig;
  /** Operator-chosen code for creating the first account (SETUP_TOKEN). */
  setupToken?: string;
  /**
   * True when the first-account page must ask for a setup code. Always, unless
   * ALLOW_OPEN_SETUP=true: a reverse proxy can make any request look like it
   * comes from loopback, so the address is not a safe reason to skip it.
   */
  setupCodeRequired?: boolean;
  /** TRUST_PROXY, already parsed for Express "trust proxy". Undefined: trust no proxy. */
  trustProxy?: number | string[];
  /** OAUTH_REDIRECT_HOSTS. Remote https hostnames an MCP client may register as its callback. */
  oauthRedirectHosts?: string[];
  /** OAUTH_ALLOW_ANY_HTTPS_REDIRECT. Accept a callback on any https host. Off by default. */
  oauthAllowAnyHttpsRedirect?: boolean;
  /**
   * OAUTH_LEGACY_CLIENT. Keep accepting client_id "mpos-mcp" (the fixed id every
   * client got before registrations were stored), for loopback and app-scheme
   * callbacks only. On by default; set false once every client has re-registered.
   */
  oauthLegacyClient?: boolean;
  /** OAUTH_REFRESH_MAX_DAYS. A sign-in's refresh chain ends this many days after sign-in. */
  refreshMaxLifetimeDays?: number;
  /** PASSWORD_HASH_CONCURRENCY: scrypt hashes run at once (64 MiB each). Default 2. */
  passwordHashConcurrency?: number;
};

/**
 * TRUST_PROXY: which proxy hops Express may believe for the client address
 * (X-Forwarded-For), which the sign-in throttle uses. Off unless set.
 * - unset, "false" or "0": trust nothing; the socket address is the client.
 * - a whole number N: trust N hops in front of the app.
 * - a comma-separated list of addresses, CIDR ranges, or the names
 *   loopback, linklocal, uniquelocal: trust proxies at those addresses.
 * "true" (trust every hop) is refused: anyone could then pick their address.
 */
export function parseTrustProxy(raw: string | undefined): number | string[] | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "false" || value === "0") return undefined;
  if (value === "true") {
    throw new Error(
      "TRUST_PROXY=true would trust any X-Forwarded-For. Set the number of proxy hops (e.g. 1) or the proxy addresses (e.g. loopback,uniquelocal).",
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) throw new Error("TRUST_PROXY hop count must be 0 to 10");
    return hops;
  }
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (!/^(loopback|linklocal|uniquelocal|[0-9a-f.:]+(\/\d{1,3})?)$/.test(entry)) {
      throw new Error(`TRUST_PROXY entry "${entry}" is not an address, a CIDR range, loopback, linklocal or uniquelocal`);
    }
  }
  return entries;
}

/** Default for OAUTH_REFRESH_MAX_DAYS. */
export const DEFAULT_REFRESH_MAX_DAYS = 30;

/** OAUTH_REFRESH_MAX_DAYS: whole days, 1 to 365. */
/** PASSWORD_HASH_CONCURRENCY: 1 to 16 scrypt hashes at once; default 2. */
export function parseHashConcurrency(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return 2;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16) {
    throw new Error("PASSWORD_HASH_CONCURRENCY must be a whole number from 1 to 16");
  }
  return Number(value);
}

export function parseRefreshMaxDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_MAX_DAYS;
  const days = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || days < 1 || days > 365) {
    throw new Error("OAUTH_REFRESH_MAX_DAYS must be a whole number of days from 1 to 365");
  }
  return days;
}

/** true/false env flag. Anything else is an error, so a typo does not silently pick the default. */
export function parseBooleanEnv(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${name} must be true or false`);
}

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
 * True when people other than whoever runs this can reach it: the bind address
 * or the public address is not loopback. A reverse proxy on 127.0.0.1 that
 * serves a public domain counts, because the public address decides.
 */
export function isPublicDeployment(bindHost: string, publicBaseUrl: string): boolean {
  const publicHost = new URL(publicBaseUrl).hostname.replace(/^\[|\]$/g, "");
  return !(isLoopbackHost(bindHost) && isLoopbackHost(publicHost));
}

/**
 * Remote Postgres must use TLS unless the host is local or an operator opts out
 * (`POSTGRES_SSL=disable`, e.g. on a private container network).
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
 * Read a Postgres URL without the WHATWG parser. Generated passwords can
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

const DATABASE_HELP =
  "Set DATABASE_URL, or POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DATABASE. scripts/init-env.sh creates a local .env.";

/** Default for POSTGRES_CONNECT_TIMEOUT_SECONDS. */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 60;

/** POSTGRES_CONNECT_TIMEOUT_SECONDS: whole seconds, 0 (try once) to 3600. */
export function parseConnectTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds > 3600) {
    throw new Error("POSTGRES_CONNECT_TIMEOUT_SECONDS must be a whole number of seconds from 0 to 3600");
  }
  return seconds;
}

export function loadDatabaseConfig(): DatabaseConfig {
  const rawUrl = envValue("DATABASE_URL");
  const fromUrl = rawUrl ? parseDatabaseUrl(rawUrl) : undefined;
  const portRaw = firstDefined(envValue("POSTGRES_PORT"), envValue("PGPORT"), fromUrl ? String(fromUrl.port) : undefined) ?? "5432";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("POSTGRES_PORT must be an integer from 1 to 65535");
  }
  const host = firstDefined(envValue("POSTGRES_HOST"), envValue("PGHOST"), fromUrl?.host) || "127.0.0.1";
  if (/\s/.test(host) || host.length > 253) {
    throw new Error(`Database host is invalid. ${DATABASE_HELP}`);
  }
  const user = assertDbIdentifier(
    firstDefined(envValue("POSTGRES_USER"), envValue("PGUSER"), fromUrl?.user) || "mpos",
    "POSTGRES_USER",
  );
  const databaseName =
    firstDefined(envValue("POSTGRES_DATABASE"), envValue("PGDATABASE"), envValue("POSTGRES_DB"), fromUrl?.database) ||
    "mpos";
  const database = assertDbIdentifier(databaseName, "POSTGRES_DATABASE");
  const password = firstDefined(envValue("POSTGRES_PASSWORD"), envValue("PGPASSWORD"), fromUrl?.password);
  if (!password) {
    throw new Error(`Database password is missing. ${DATABASE_HELP}`);
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
    connectTimeoutSeconds: parseConnectTimeoutSeconds(envValue("POSTGRES_CONNECT_TIMEOUT_SECONDS")),
  };
}

export function loadConfig(): AppConfig {
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
    legacyOrigin ||
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  if (!publicBaseUrl) {
    throw new Error(
      "Missing PUBLIC_BASE_URL. Set it to the address people open, e.g. https://library.example.org.",
    );
  }
  const authMode: AuthMode = process.env.AUTH_MODE === "oidc" ? "oidc" : "embedded";
  const authIssuer = (
    authMode === "embedded"
      ? `${publicBaseUrl}/id`
      : process.env.AUTH_ISSUER?.trim() || ""
  ).replace(/\/$/, "");
  if (!authIssuer) {
    throw new Error("AUTH_ISSUER is required when AUTH_MODE=oidc");
  }
  const authAudience = process.env.AUTH_AUDIENCE?.trim() || publicBaseUrl;
  const authMcpAudience = authMode === "oidc" ? process.env.AUTH_MCP_AUDIENCE?.trim() || undefined : undefined;
  if (authMode === "oidc" && !authMcpAudience) {
    console.warn(
      "AUTH_MCP_AUDIENCE is not set: library MCP accepts tokens for AUTH_AUDIENCE, the same audience as web sign-in. Give MCP its own audience (docs/deploy.md).",
    );
  }
  const sessionSecret = assertSessionSecret(required("SESSION_SECRET"));
  const setupToken = envValue("SETUP_TOKEN");
  if (setupToken && setupToken.length < SETUP_TOKEN_MIN_LENGTH) {
    throw new Error(
      `SETUP_TOKEN must be at least ${SETUP_TOKEN_MIN_LENGTH} characters. Generate one with: openssl rand -base64 18`,
    );
  }
  // Containers set BIND_HOST=0.0.0.0 (the Dockerfile does). Everything else stays on loopback.
  const bindHost = process.env.BIND_HOST?.trim() || "127.0.0.1";
  const allowOpenSetup = parseBooleanEnv("ALLOW_OPEN_SETUP", process.env.ALLOW_OPEN_SETUP, false);
  if (allowOpenSetup && isPublicDeployment(bindHost, publicBaseUrl)) {
    console.warn(
      "ALLOW_OPEN_SETUP=true on an address others can reach: whoever opens the page first becomes SA. Remove it once the first account exists.",
    );
  }

  return {
    port: Number(process.env.PORT ?? "3000"),
    bindHost,
    publicBaseUrl,
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
    authMode,
    authIssuer,
    authJwksUrl:
      process.env.AUTH_JWKS_URL?.trim() ||
      (authMode === "embedded"
        ? `${authIssuer}/jwks`
        : `${authIssuer}/protocol/openid-connect/certs`),
    authAudience,
    authMcpAudience,
    webClientId: process.env.WEB_CLIENT_ID ?? "mpos-web",
    sessionSecret,
    database: loadDatabaseConfig(),
    setupToken,
    setupCodeRequired: !allowOpenSetup,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    oauthRedirectHosts: parseAllowedHosts(process.env.OAUTH_REDIRECT_HOSTS),
    oauthAllowAnyHttpsRedirect: parseBooleanEnv(
      "OAUTH_ALLOW_ANY_HTTPS_REDIRECT",
      process.env.OAUTH_ALLOW_ANY_HTTPS_REDIRECT,
      false,
    ),
    oauthLegacyClient: parseBooleanEnv("OAUTH_LEGACY_CLIENT", process.env.OAUTH_LEGACY_CLIENT, true),
    refreshMaxLifetimeDays: parseRefreshMaxDays(process.env.OAUTH_REFRESH_MAX_DAYS),
    passwordHashConcurrency: parseHashConcurrency(process.env.PASSWORD_HASH_CONCURRENCY),
  };
}

/** Placeholder values that have appeared in docs or examples. Never valid. */
const KNOWN_PLACEHOLDER_SECRETS = new Set(["change-me-to-a-long-random-value"]);

/**
 * SESSION_SECRET signs the UI session cookie. A guessable value lets anyone
 * forge a session, so reject short values, copied placeholders, and
 * single-character repeats. Generate one with `openssl rand -base64 48`.
 */
export function assertSessionSecret(value: string): string {
  if (value.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48");
  }
  const lowered = value.toLowerCase();
  if (KNOWN_PLACEHOLDER_SECRETS.has(lowered) || lowered.includes("change-me") || lowered.includes("changeme")) {
    throw new Error("SESSION_SECRET is still the example placeholder. Generate one with: openssl rand -base64 48");
  }
  if (new Set(value).size < 8) {
    throw new Error("SESSION_SECRET is too repetitive. Generate one with: openssl rand -base64 48");
  }
  return value;
}

/** True when a leftover SQLite file is still on disk. The app does not read it. */
export function legacySqliteFilePresent(): boolean {
  return existsSync("./data/mpos.db");
}
