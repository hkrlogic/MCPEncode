import type { AppConfig } from "../config.ts";

/**
 * Audience a library MCP access token must carry.
 * The embedded IdP mints one audience per library link. Zitadel cannot: its
 * token audience is the project id in AUTH_AUDIENCE. The library access list
 * is what still decides which library that token may open.
 */
export function libraryTokenAudience(config: AppConfig, libraryUrl: string): string {
  if (config.authMode === "oidc") return config.authAudience;
  return libraryUrl.replace(/\/$/, "");
}
