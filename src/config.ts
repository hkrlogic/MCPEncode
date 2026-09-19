/**
 * Runtime configuration. Values come from the environment so the same
 * process can sit behind Keycloak locally or any OAuth 2.1 issuer later.
 */
export type AuthMode = "embedded" | "oidc";

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
  databasePath: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const mcpResourceUrl = required("MCP_RESOURCE_URL").replace(/\/$/, "");
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000").replace(
    /\/$/,
    "",
  );
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
    bindHost: process.env.BIND_HOST ?? "127.0.0.1",
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
    databasePath: process.env.DATABASE_PATH ?? "./data/mpos.db",
  };
}
