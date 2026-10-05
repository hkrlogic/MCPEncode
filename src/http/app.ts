/** Express app composer: static assets, OAuth metadata, routes, MCP mount. */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import type { Database } from "../db/types.ts";
import type { AppConfig } from "../config.ts";
import { createTokenVerifier } from "../auth/verifier.ts";
import {
  FORBIDDEN_LIBRARY,
  UNAUTHORIZED_MCP,
  buildMcpServer,
  resolveLibraryMcpAccess,
} from "../mcp/server.ts";
import type { AuthServerEndpoints } from "./discovery.ts";
import { isLibraryId, libraryMcpUrl } from "./library-url.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import type { AppRouteContext } from "./routes/context.ts";
import { registerEditorRoutes } from "./routes/editor.ts";
import { registerItemRoutes } from "./routes/items.ts";
import { registerLibraryRoutes } from "./routes/libraries.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../../public");

export function createApp(input: {
  config: AppConfig;
  db: Database;
  authServer: AuthServerEndpoints;
  verifierKey?: Parameters<typeof createTokenVerifier>[0]["localKey"];
  mountAuthServer?: (app: express.Express) => void;
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
  // Origin validation rejects the literal browser value "null" (opaque origins), which
  // OAuth redirects from a local app to /id/authorize often send. Host allowlisting is
  // enough on public binds; keep Origin checks only on loopback for DNS-rebinding defense.
  const loopbackBind = ["127.0.0.1", "localhost", "::1"].includes(config.bindHost);
  const app = createMcpExpressApp({
    host: config.bindHost,
    allowedHosts: allowedNames,
    ...(loopbackBind ? { allowedOrigins: allowedNames } : {}),
  });
  app.use(express.urlencoded({ extended: false }));

  // Authorization Server metadata (RFC 8414) at the publisher origin.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authServer.metadata);
  });
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.json(authServer.metadata);
  });

  // Per-library Protected Resource Metadata (RFC 9728 path-aware well-known).
  app.get(
    "/.well-known/oauth-protected-resource/libraries/:libraryId/mcp",
    (req, res) => {
      const libraryId = req.params.libraryId;
      if (!isLibraryId(libraryId)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const resourceUrl = new URL(libraryMcpUrl(config.publicBaseUrl, libraryId));
      const metadata = buildOAuthProtectedResourceMetadata({
        oauthMetadata: authServer.metadata,
        resourceServerUrl: resourceUrl,
        resourceName: "MCPEncode library",
        scopesSupported: ["openid", "mpos:readonly", "mpos:edit"],
        dangerouslyAllowInsecureIssuerUrl:
          resourceUrl.protocol === "http:" ||
          process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true",
      });
      res.json(metadata);
    },
  );

  app.use("/static", express.static(publicDir));
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

  const webVerifier = createTokenVerifier({
    issuer: config.authIssuer,
    audience: config.authAudience,
    jwksUrl: config.authJwksUrl,
    localKey: input.verifierKey,
  });
  const ctx: AppRouteContext = { config, db, authServer, verifier: webVerifier };
  registerAuthRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
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

  // Per-library MCP. Token audience must match this library's URL.
  app.all("/libraries/:libraryId/mcp", async (req, res, next) => {
    const libraryId = req.params.libraryId;
    if (!isLibraryId(libraryId)) {
      res.status(404).json({ error: "not_found", error_description: "Library not found." });
      return;
    }
    const resourceUrl = new URL(libraryMcpUrl(config.publicBaseUrl, libraryId));
    const verifier = createTokenVerifier({
      issuer: config.authIssuer,
      audience: resourceUrl.toString().replace(/\/$/, ""),
      jwksUrl: config.authJwksUrl,
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
        const scoped = await resolveLibraryMcpAccess(db, authInfo, libraryId);
        if ("error" in scoped) {
          const status = scoped.error === FORBIDDEN_LIBRARY ? 403 : 404;
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
