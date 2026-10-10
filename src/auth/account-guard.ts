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

export type AccountCheck = { allowed: true; role: Role } | { allowed: false };

/** Returns the account's current standing, or `allowed: false` when it is disabled or gone. */
export type AccountGuard = (sub: string) => Promise<AccountCheck>;

export function createAccountGuard(accounts: AccountStore): AccountGuard {
  return async (sub) => {
    const account = await accounts.findById(sub);
    if (!account || account.disabled) return { allowed: false };
    return { allowed: true, role: account.role };
  };
}
