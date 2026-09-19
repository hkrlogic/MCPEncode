import "dotenv/config";
import { createEmbeddedIdp } from "./auth/embedded-idp.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { createApp } from "./http/app.ts";
import { loadAuthServer } from "./http/discovery.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openDatabase(config.databasePath);

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
    console.log(`Mpos UI  http://${config.bindHost}:${config.port}/`);
    console.log(`Mpos MCP ${config.mcpResourceUrl}`);
    console.log(`Issuer   ${config.authIssuer} (${config.authMode})`);
    if (config.authMode === "embedded") {
      console.log("Sign in  editor / editor-pass  or  reader / reader-pass");
    }
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
