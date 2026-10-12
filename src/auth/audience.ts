import type { AppConfig } from "../config.ts";

/**
 * Audience a library MCP access token must carry.
 * The embedded IdP mints one audience per library link. An external OIDC
 * provider cannot: its tokens carry a fixed audience, AUTH_MCP_AUDIENCE (or
 * AUTH_AUDIENCE when that is unset). The library access list is what still
 * decides which library that token may open.
 */
export function libraryTokenAudience(config: AppConfig, libraryUrl: string): string {
  if (config.authMode === "oidc") return config.authMcpAudience || config.authAudience;
  return libraryUrl.replace(/\/$/, "");
}
