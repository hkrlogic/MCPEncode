/** Shared dependencies injected into route registrars. */
import type { Database } from "../../db/types.ts";
import type { AppConfig } from "../../config.ts";
import type { createTokenVerifier } from "../../auth/verifier.ts";
import type { AuthServerEndpoints } from "../discovery.ts";

export type AppRouteContext = {
  config: AppConfig;
  db: Database;
  authServer: AuthServerEndpoints;
  verifier: ReturnType<typeof createTokenVerifier>;
};
