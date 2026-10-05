import "dotenv/config";
import { createEmbeddedIdp } from "./auth/embedded-idp.ts";
import { legacySqliteFilePresent, loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { createApp } from "./http/app.ts";
import { loadAuthServer } from "./http/discovery.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openDatabase(config.database);

  const embedded =
    config.authMode === "embedded" ? await createEmbeddedIdp(config) : undefined;
  const authServer = embedded ? embedded.endpoints : await loadAuthServer(config.authIssuer);

  const app = createApp({
    config,
    db,
    authServer,
    verifierKey: embedded?.publicKey,
    mountAuthServer: embedded?.mount,
  });

  app.listen(config.port, config.bindHost, () => {
    console.log(`MCPEncode UI  http://${config.bindHost}:${config.port}/`);
    console.log(`MCPEncode MCP ${config.publicBaseUrl}/libraries/{id}/mcp`);
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
