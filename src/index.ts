import "dotenv/config";
import { createEmbeddedIdp } from "./auth/embedded-idp.ts";
import { setHashConcurrency } from "./auth/passwords.ts";
import { legacySqliteFilePresent, loadConfig, OAUTH_LIMITS } from "./config.ts";
import { accountStore } from "./db/accounts.ts";
import { openDatabase } from "./db/client.ts";
import { postgresIdpStore, postgresKnownGoodStore } from "./db/idp-store.ts";
import { writeAudit } from "./db/audit.ts";
import { getLibrary, getLibraryAccess } from "./db/queries.ts";
import { createApp } from "./http/app.ts";
import { loadAuthServer } from "./http/discovery.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  setHashConcurrency(OAUTH_LIMITS.passwordHashConcurrency);
  const db = await openDatabase(config.database);

  const accounts = config.authMode === "embedded" ? accountStore(db) : undefined;
  const embedded = accounts
    ? await createEmbeddedIdp(config, accounts, {
        store: postgresIdpStore(db, config.sessionSecret),
        knownGoodStore: postgresKnownGoodStore(db),
        libraryName: async (id) => (await getLibrary(db, id))?.name,
        libraryRole: async (id, sub) => (await getLibraryAccess(db, id, sub))?.role,
        audit: (event) => writeAudit(db, event),
      })
    : undefined;
  const authServer = embedded ? embedded.endpoints : await loadAuthServer(config.authIssuer);

  const app = createApp({
    config,
    db,
    authServer,
    verifierKey: embedded?.publicKey,
    mountAuthServer: embedded?.mount,
    revokeAccount: embedded?.revokeAccount,
    callbackHosts: embedded?.callbackHosts,
    accounts,
  });

  app.listen(config.port, config.bindHost, () => {
    console.log(`MCPEncode UI  http://${config.bindHost}:${config.port}/`);
    console.log(`MCPEncode MCP ${config.publicBaseUrl}/libraries/{id}/mcp/{token} (copy from Connect)`);
    console.log(`Issuer   ${config.authIssuer} (${config.authMode})`);
    console.log(
      `Postgres ${config.database.host}:${config.database.port}/${config.database.database}`,
    );
    if (legacySqliteFilePresent()) {
      console.log("data/mpos.db is unused. Delete the data folder when you want the space back.");
    }
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
