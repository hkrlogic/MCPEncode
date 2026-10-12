/** Express app composer: static assets, OAuth metadata, routes, MCP mount. */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import type { Database } from "../db/types.ts";
import { getLibrary, getLibraryReaderKeyHash, getShelf } from "../db/queries.ts";
import {
  bearerFromAuthorization,
  isReaderKeyToken,
  readerKeyAuthInfo,
  readerKeyMatches,
} from "../auth/reader-key.ts";
import { createAccountGuard, type AccountGuard } from "../auth/account-guard.ts";
import type { AccountStore } from "../auth/accounts.ts";
import type { AppConfig } from "../config.ts";
import { libraryTokenAudience } from "../auth/audience.ts";
import { loginScopes } from "../auth/scopes.ts";
import { createTokenVerifier } from "../auth/verifier.ts";
import {
  ACCOUNT_UNAVAILABLE,
  FORBIDDEN_LIBRARY,
  READER_KEY_REJECTED,
  UNAUTHORIZED_MCP,
  buildMcpServer,
  readerKeyLibraryContext,
  resolveLibraryMcpAccess,
} from "../mcp/server.ts";
import type { AuthServerEndpoints } from "./discovery.ts";
import { healthHandler } from "./health.ts";
import {
  connectTokensMatch,
  isConnectToken,
  isLibraryId,
  libraryMcpUrl,
} from "./library-url.ts";
import { registerAccountRoutes } from "./routes/accounts.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import type { AppRouteContext } from "./routes/context.ts";
import { registerEditorRoutes } from "./routes/editor.ts";
import { registerItemRoutes } from "./routes/items.ts";
import { registerLibraryRoutes } from "./routes/libraries.ts";
import { registerShelfRoutes } from "./routes/shelves.ts";
import { originAllowed } from "./origin.ts";
import { securityHeaders } from "./security-headers.ts";
import { staticPublicDir } from "./static-assets.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = staticPublicDir();

export function createApp(input: {
  config: AppConfig;
  db: Database;
  authServer: AuthServerEndpoints;
  verifierKey?: Parameters<typeof createTokenVerifier>[0]["localKey"];
  mountAuthServer?: (app: express.Express) => void;
  /** Built-in sign-in: sign an account out everywhere. */
  revokeAccount?: (sub: string) => Promise<void>;
  /** Built-in accounts. When set, sessions and tokens are re-checked against the account on every request. */
  accounts?: AccountStore;
}) {
  const { config, db, authServer } = input;
  const originHost = new URL(config.publicBaseUrl).hostname;
  // Hostnames only. A full URL here makes the SDK reject the browser Host header.
  // PUBLIC_BASE_URL must match the domain people open.
  // ALLOWED_HOSTS adds extras (www, cutover domains) without changing OAuth redirects.
  const bindAsHost =
    config.bindHost === "0.0.0.0" || config.bindHost === "::" ? "" : config.bindHost;
  const allowedNames = [
    ...new Set(
      [
        bindAsHost,
        originHost,
        ...config.allowedHosts,
        "127.0.0.1",
        "localhost",
        "[::1]",
      ].filter((name) => name.length > 0),
    ),
  ];
  // Same middleware as the SDK's createMcpExpressApp({ host: "0.0.0.0", allowedHosts }),
  // built by hand so /healthz can sit in front of the Host check: platform health
  // probes often send an internal Host name. The SDK's own Origin check rejects the
  // browser value "null", which is what follows the sign-in form redirect, so it
  // stays off. Listening still uses config.bindHost. Host allowlisting stays on, and
  // the origin check below allows the sign-in navigation while rejecting other sites.
  const app = express();
  // No auth and no Host check. Returns only ok / unavailable.
  app.get("/healthz", healthHandler(db));
  app.use(express.json());
  app.use(hostHeaderValidation(allowedNames));
  app.use((req, res, next) => {
    const header = req.headers.origin;
    const origin = Array.isArray(header) ? header[0] : header;
    const modeHeader = req.headers["sec-fetch-mode"];
    const secFetchMode = Array.isArray(modeHeader) ? modeHeader[0] : modeHeader;
    const siteHeader = req.headers["sec-fetch-site"];
    const secFetchSite = Array.isArray(siteHeader) ? siteHeader[0] : siteHeader;
    const result = originAllowed({
      origin,
      method: req.method,
      secFetchMode,
      secFetchSite,
      allowedHostnames: allowedNames,
    });
    if (result.ok) {
      next();
      return;
    }
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: result.message },
      id: null,
    });
  });
  app.disable("x-powered-by");
  app.use(securityHeaders({ https: config.publicBaseUrl.startsWith("https://") }));
  if (input.accounts) app.locals.accountGuard = createAccountGuard(input.accounts);
  // Only when the operator says a proxy is in front (TRUST_PROXY). Otherwise a
  // client could choose its own address for the sign-in throttle.
  if (config.trustProxy !== undefined) app.set("trust proxy", config.trustProxy);
  app.use(express.urlencoded({ extended: false }));

  // Authorization Server metadata (RFC 8414) at the publisher origin.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authServer.metadata);
  });
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.json(authServer.metadata);
  });

  // Per-library Protected Resource Metadata (RFC 9728 path-aware well-known).
  // The connect token must match so a rotated link cannot be rediscovered.
  app.get(
    "/.well-known/oauth-protected-resource/libraries/:libraryId/mcp/:connectToken",
    (req, res, next) => {
      void (async () => {
        const libraryId = req.params.libraryId;
        const connectToken = req.params.connectToken;
        if (!isLibraryId(libraryId) || !isConnectToken(connectToken)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const library = await getLibrary(db, libraryId);
        if (!library || !connectTokensMatch(library.connectToken, connectToken)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const resourceUrl = new URL(
          libraryMcpUrl(config.publicBaseUrl, library.id, library.connectToken),
        );
        const metadata = buildOAuthProtectedResourceMetadata({
          oauthMetadata: authServer.metadata,
          resourceServerUrl: resourceUrl,
          resourceName: "MCPEncode library",
          scopesSupported: loginScopes(config),
          dangerouslyAllowInsecureIssuerUrl:
            resourceUrl.protocol === "http:" ||
            process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true",
        });
        res.json(metadata);
      })().catch(next);
    },
  );

  // Fingerprinted query strings bust Cloudflare/browser caches after deploys.
  // Keep a short max-age so a missed fingerprint still revalidates quickly.
  app.use(
    "/static",
    express.static(publicDir, {
      maxAge: "5m",
      etag: true,
      lastModified: true,
    }),
  );
  const projectRoot = path.resolve(dirname, "../..");
  const jsuitesDist = [
    path.join(projectRoot, "node_modules/jspreadsheet-ce/node_modules/jsuites/dist"),
    path.join(projectRoot, "node_modules/jsuites/dist"),
  ].find((dir) => existsSync(dir));
  if (jsuitesDist) {
    app.use("/vendor/jsuites", express.static(jsuitesDist));
  }
  app.use(
    "/vendor/jspreadsheet",
    express.static(path.join(projectRoot, "node_modules/jspreadsheet-ce/dist")),
  );
  input.mountAuthServer?.(app);

  const jwksUrl = config.authJwksUrl || authServer.metadata.jwks_uri;
  const webVerifier = createTokenVerifier({
    issuer: config.authIssuer,
    audience: config.authAudience,
    jwksUrl,
    localKey: input.verifierKey,
  });
  const ctx: AppRouteContext = {
    config,
    db,
    authServer,
    verifier: webVerifier,
    revokeAccount: input.revokeAccount,
  };
  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerShelfRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerEditorRoutes(app, ctx);

  // Global /mcp is retired. Agents connect with a library link only.
  app.all("/mcp", (_req, res) => {
    res.status(410).json({
      error: "gone",
      error_description:
        "The global MCP link is retired. Connect with a library MCP URL from the publisher (Open library → copy the MCP link).",
    });
  });

  // Tokenless library MCP URLs are retired — use Connect (includes the secret).
  app.all("/libraries/:libraryId/mcp", (_req, res) => {
    res.status(410).json({
      error: "gone",
      error_description:
        "This Connect link is incomplete or was rotated. Copy the current link from the publisher (Open library → Connect).",
    });
  });

  // Per-library MCP. Embedded tokens are bound to this library URL.
  // Zitadel tokens are bound to the project audience; the access list scopes them.
  app.all("/libraries/:libraryId/mcp/:connectToken", async (req, res, next) => {
    const libraryId = req.params.libraryId;
    const connectToken = req.params.connectToken;
    if (!isLibraryId(libraryId) || !isConnectToken(connectToken)) {
      res.status(404).json({ error: "not_found", error_description: "Library not found." });
      return;
    }
    const library = await getLibrary(db, libraryId);
    if (!library || !connectTokensMatch(library.connectToken, connectToken)) {
      res.status(404).json({
        error: "not_found",
        error_description:
          "Library not found, or this Connect link was rotated. Copy the current link from the publisher.",
      });
      return;
    }
    const resourceUrl = new URL(
      libraryMcpUrl(config.publicBaseUrl, library.id, library.connectToken),
    );

    // Reader key: one library, published items only. Handled before OAuth so a
    // shared agent is not sent through the sign-in screen. A bad key does not
    // advertise the OAuth challenge.
    const authorization = req.headers.authorization;
    const bearer = bearerFromAuthorization(typeof authorization === "string" ? authorization : undefined);
    if (bearer && isReaderKeyToken(bearer)) {
      const stored = await getLibraryReaderKeyHash(db, library.id);
      if (!readerKeyMatches(bearer, stored)) {
        res.status(401).json({
          error: "invalid_token",
          error_description: READER_KEY_REJECTED,
        });
        return;
      }
      const authInfo = readerKeyAuthInfo(library.id);
      (req as express.Request & { auth?: typeof authInfo }).auth = authInfo;
      const shelfName = library.shelfId ? (await getShelf(db, library.shelfId))?.name ?? null : null;
      const scoped = readerKeyLibraryContext({ ...library, shelfName });
      const mcpHandler = createMcpHandler(({ authInfo: info }) => {
        if (!info) throw new Error("MCP handler invoked without authInfo");
        return buildMcpServer(db, info, scoped, { publicBaseUrl: config.publicBaseUrl });
      });
      void toNodeHandler(mcpHandler)(req, res, req.body);
      return;
    }

    const verifier = createTokenVerifier({
      issuer: config.authIssuer,
      audience: libraryTokenAudience(config, resourceUrl.toString()),
      jwksUrl,
      localKey: input.verifierKey,
    });
    const authGate = requireBearerAuth({
      verifier,
      requiredScopes: ["records.read"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    });

    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 401 && body && typeof body === "object" && !Array.isArray(body)) {
        return sendJson({
          ...(body as Record<string, unknown>),
          error_description: UNAUTHORIZED_MCP,
        });
      }
      return sendJson(body);
    }) as typeof res.json;

    authGate(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      void (async () => {
        const authInfo = (
          req as express.Request & { auth?: Parameters<typeof buildMcpServer>[1] }
        ).auth;
        if (!authInfo) {
          res.status(401).json({
            error: "invalid_token",
            error_description: UNAUTHORIZED_MCP,
          });
          return;
        }
        const scoped = await resolveLibraryMcpAccess(
          db,
          authInfo,
          libraryId,
          app.locals.accountGuard as AccountGuard | undefined,
        );
        if ("error" in scoped) {
          const status =
            scoped.error === FORBIDDEN_LIBRARY || scoped.error === ACCOUNT_UNAVAILABLE ? 403 : 404;
          res.status(status).json({
            error: status === 403 ? "access_denied" : "not_found",
            error_description: scoped.error,
          });
          return;
        }
        const mcpHandler = createMcpHandler(({ authInfo: info }) => {
          if (!info) {
            throw new Error("MCP handler invoked without authInfo");
          }
          return buildMcpServer(db, info, scoped, {
            publicBaseUrl: config.publicBaseUrl,
          });
        });
        const nodeMcp = toNodeHandler(mcpHandler);
        void nodeMcp(req, res, req.body);
      })().catch(next);
    });
  });

  return app;
}
