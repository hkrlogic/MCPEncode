import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { accessFromIdentity, resolveRole, type Access, type Role } from "./rbac.ts";

export type VerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  /** Test hook: verify against a local key instead of a JWKS URL. */
  localKey?: Parameters<typeof jwtVerify>[1];
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function rolesFromPayload(payload: JWTPayload): string[] {
  const realm = payload.realm_access;
  const realmRoles =
    realm && typeof realm === "object" && "roles" in realm
      ? asStringArray((realm as { roles: unknown }).roles)
      : [];
  return [
    ...asStringArray(payload.mpos_roles),
    ...asStringArray(payload.roles),
    ...realmRoles,
  ];
}

export function accessFromAuthInfo(auth: AuthInfo): Access {
  const extra = (auth.extra ?? {}) as { sub?: string; role?: Role };
  const role = extra.role;
  if (!role) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "token is missing a Mpos role");
  }
  return accessFromIdentity({
    sub: extra.sub || auth.clientId,
    clientId: auth.clientId,
    role,
  });
}

export function createTokenVerifier(options: VerifierOptions): OAuthTokenVerifier {
  const jwks = options.localKey
    ? null
    : createRemoteJWKSet(new URL(options.jwksUrl ?? `${options.issuer}/protocol/openid-connect/certs`));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        const verified = options.localKey
          ? await jwtVerify(token, options.localKey, {
              issuer: options.issuer,
              audience: options.audience,
            })
          : await jwtVerify(token, jwks!, {
              issuer: options.issuer,
              audience: options.audience,
            });
        payload = verified.payload;
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "access token failed verification");
      }

      if (typeof payload.exp !== "number") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "access token is missing exp");
      }

      const scopes = asStringArray(payload.scope);
      const roles = rolesFromPayload(payload);
      const role = resolveRole({ scopes, roles });
      if (!role) {
        throw new OAuthError(
          OAuthErrorCode.InsufficientScope,
          "token has neither mpos:readonly nor mpos:edit",
        );
      }

      const sub = typeof payload.sub === "string" ? payload.sub : "";
      const clientId =
        (typeof payload.azp === "string" && payload.azp) ||
        (typeof payload.client_id === "string" && payload.client_id) ||
        sub;
      if (!sub) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "access token is missing sub");
      }

      const access = accessFromIdentity({ sub, clientId, role });
      return {
        token,
        clientId,
        scopes: [...access.permissions],
        expiresAt: payload.exp,
        extra: { sub, role },
      };
    },
  };
}
