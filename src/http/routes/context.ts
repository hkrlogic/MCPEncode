/** Shared dependencies injected into route registrars. */
import type { Database } from "../../db/types.ts";
import type { AppConfig } from "../../config.ts";
import type { createTokenVerifier } from "../../auth/verifier.ts";
import type { AuthServerEndpoints } from "../discovery.ts";
import type { CallbackHostAdmin } from "../../auth/embedded-idp.ts";

export type AppRouteContext = {
  config: AppConfig;
  db: Database;
  authServer: AuthServerEndpoints;
  verifier: ReturnType<typeof createTokenVerifier>;
  /**
   * Built-in sign-in: sign an account out everywhere (refresh chains, sessions,
   * access tokens). Called on sign-out and password reset. Unset with AUTH_MODE=oidc.
   */
  revokeAccount?: (sub: string) => Promise<void>;
  /** Built-in sign-in: approve or deny hosted apps' callback hosts (Settings → Apps). */
  callbackHosts?: CallbackHostAdmin;
};
