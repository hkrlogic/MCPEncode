import type { AppConfig } from "../config.ts";

/**
 * Scopes for a Zitadel login.
 * The role scope puts project roles on the token. The audience scope adds the
 * project id to `aud`. Zitadel rejects scope names it does not know, so the
 * embedded IdP's `mpos:*` scopes must not be sent here.
 */
export function oidcLoginScopes(projectAudience: string): string[] {
  return [
    "openid",
    "urn:zitadel:iam:org:project:roles",
    `urn:zitadel:iam:org:project:id:${projectAudience}:aud`,
  ];
}

/** Scopes this publisher requests. Embedded and Zitadel do not share a list. */
export function loginScopes(config: AppConfig): string[] {
  if (config.authMode === "oidc") return oidcLoginScopes(config.authAudience);
  return ["openid", "mpos:readonly", "mpos:edit", "mpos:sa"];
}
