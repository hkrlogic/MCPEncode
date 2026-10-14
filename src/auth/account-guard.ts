/**
 * Live account check for the built-in sign-in.
 *
 * A session cookie, an access token and a refresh token all carry the role the
 * person had when they signed in. Without this check, disabling or demoting an
 * account would not touch any of them. The guard looks the account up again on
 * every request, so Disable and Remove SA take effect at once.
 *
 * It applies to built-in accounts only. With an external identity provider
 * (AUTH_MODE=oidc) the provider owns who may sign in, and no guard is set.
 */
import type { AccountStore } from "./accounts.ts";
import type { Role } from "./rbac.ts";

/**
 * `disabled`: the account is disabled or gone; an SA must act.
 * `signed_out`: the credential predates a sign-out everywhere or a password
 * reset; signing in again fixes it.
 */
export type AccountDenial = "disabled" | "signed_out";
export type AccountCheck = { allowed: true; role: Role } | { allowed: false; reason: AccountDenial };

/**
 * Returns the account's current standing, or `allowed: false` when it is
 * disabled, gone, or the credential was issued before the account was signed
 * out everywhere (sign-out, password reset). `issuedAt` is the JWT iat, in seconds.
 */
export type AccountGuard = (sub: string, issuedAt?: number) => Promise<AccountCheck>;

export function createAccountGuard(accounts: AccountStore): AccountGuard {
  return async (sub, issuedAt) => {
    const account = await accounts.findById(sub);
    if (!account || account.disabled) return { allowed: false, reason: "disabled" };
    const revokedAt = account.sessionsRevokedAt ?? 0;
    if (revokedAt > 0 && (issuedAt === undefined || issuedAt * 1000 < revokedAt)) {
      return { allowed: false, reason: "signed_out" };
    }
    return { allowed: true, role: account.role };
  };
}
