/**
 * Every environment variable the app reads, in one machine-readable list.
 * src/config.ts is what actually parses them; test/env-schema.test.ts checks
 * that this list, config.ts and the table in docs/deploy.md agree.
 * `npm run check-env` validates a .env against it.
 */
export type EnvVar = {
  name: string;
  /** "yes": startup fails without it. "oidc": required when AUTH_MODE=oidc. */
  required: "yes" | "no" | "oidc";
  /** Value used when unset ("" when there is none). */
  default: string;
  /** True for secrets that must never be printed. */
  secret?: boolean;
  description: string;
};

export const ENV_VARS: readonly EnvVar[] = [
  { name: "PUBLIC_BASE_URL", required: "no", default: "http://127.0.0.1:3000", description: "Address people open. https:// unless loopback." },
  { name: "PORT", required: "no", default: "3000", description: "Port the app listens on." },
  { name: "BIND_HOST", required: "no", default: "127.0.0.1", description: "Interface to listen on. The container image sets 0.0.0.0." },
  { name: "SESSION_SECRET", required: "yes", default: "", secret: true, description: "Signs the session cookie. 32+ random characters (scripts/init-env.sh)." },
  { name: "SETUP_TOKEN", required: "no", default: "", secret: true, description: "Code the first-account page asks for (16+ characters). Unset: a random one is printed to the log." },
  { name: "POSTGRES_HOST", required: "no", default: "127.0.0.1", description: "Database host. Compose sets postgres." },
  { name: "POSTGRES_PORT", required: "no", default: "5432", description: "Database port." },
  { name: "POSTGRES_USER", required: "no", default: "mcpencode", description: "Database user." },
  { name: "POSTGRES_PASSWORD", required: "yes", default: "", secret: true, description: "Database password (or in DATABASE_URL)." },
  { name: "POSTGRES_DATABASE", required: "no", default: "mcpencode", description: "Database name." },
  { name: "DATABASE_URL", required: "no", default: "", secret: true, description: "postgresql://user:password@host:5432/db, instead of the POSTGRES_* lines." },
  { name: "POSTGRES_SSL", required: "no", default: "", description: "required or disable. Must be set for a non-loopback database host." },
  { name: "POSTGRES_CONNECT_TIMEOUT_SECONDS", required: "no", default: "60", description: "How long startup retries an unreachable database (0 = once)." },
  { name: "TRUST_PROXY", required: "no", default: "", description: "Reverse proxies allowed to set X-Forwarded-For: hop count or addresses/CIDR/loopback/uniquelocal. Compose sets uniquelocal." },
  { name: "ALLOWED_HOSTS", required: "no", default: "", description: "Extra hostnames (comma-separated) that may reach the app." },
  { name: "ALLOW_INSECURE_HTTP", required: "no", default: "false", description: "Accept a plain http PUBLIC_BASE_URL on a non-loopback host. Not recommended." },
  { name: "MCP_RATE_LIMIT_PER_MINUTE", required: "no", default: "300", description: "Library MCP requests per client address per minute. 0 turns it off." },
  { name: "OAUTH_REDIRECT_HOSTS", required: "no", default: "", description: "Remote https callback hosts approved up front, e.g. claude.ai. A Site admin can also approve hosts in the app (Settings → Apps)." },
  { name: "AUTH_MODE", required: "no", default: "embedded", description: "embedded (built-in accounts) or oidc (external issuer, docs/oidc.md)." },
  { name: "AUTH_ISSUER", required: "oidc", default: "", description: "External issuer URL." },
  { name: "AUTH_AUDIENCE", required: "no", default: "PUBLIC_BASE_URL", description: "Audience of web sign-in tokens." },
  { name: "AUTH_MCP_AUDIENCE", required: "oidc", default: "", description: "Audience of library MCP tokens, kept separate from AUTH_AUDIENCE." },
  { name: "AUTH_JWKS_URL", required: "no", default: "AUTH_ISSUER/protocol/openid-connect/certs", description: "Issuer key set URL (oidc mode). Zitadel: AUTH_ISSUER/oauth/v2/keys." },
  { name: "WEB_CLIENT_ID", required: "no", default: "mcpencode-web", description: "Client id of the web app at the issuer (oidc mode)." },
];

/** Older spellings still read so existing setups keep working. Not documented as primary. */
export const ALIAS_ENV_VARS: readonly string[] = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "POSTGRES_DB",
  "MCP_RESOURCE_URL",
];

/** Removed settings. If still set they are ignored with a one-line warning at startup. */
export const REMOVED_ENV_VARS: readonly string[] = [
  "OAUTH_LEGACY_CLIENT",
  "OAUTH_REGISTER_RATE_LIMIT",
  "OAUTH_AUTHORIZE_RATE_LIMIT",
  "OAUTH_MAX_PENDING_CLIENTS",
  "OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS",
  "OAUTH_PENDING_CLIENT_TTL_MINUTES",
  "PASSWORD_HASH_CONCURRENCY",
  "OAUTH_REFRESH_MAX_DAYS",
  "OAUTH_ALLOWED_SCHEMES",
  "OAUTH_ALLOW_ANY_HTTPS_REDIRECT",
  "MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL",
  "AUTH_MCP_AUDIENCE_SHARED",
  "ALLOW_OPEN_SETUP",
];
