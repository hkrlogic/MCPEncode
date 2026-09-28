import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Database } from "../db/types.ts";
import type { AppConfig } from "../config.ts";
import { accessFromIdentity, can, type Access, type Role } from "../auth/rbac.ts";
import { readSession, signSession } from "../auth/session.ts";
import { createTokenVerifier } from "../auth/verifier.ts";
import {
  createLibrary,
  createItem,
  deleteLibrary,
  deleteItem,
  getLibrary,
  getItem,
  listLibraries,
  listItems,
  updateItem,
  writeAudit,
} from "../db/queries.ts";
import { itemInputSchema, libraryInputSchema, parseLabelField } from "../items/schema.ts";
import {
  itemForLibrary,
  policyBody,
  policyControl,
  procedureBody,
  procedureControl,
  type LibraryTemplate,
} from "../items/templates.ts";
import { htmlToMarkdown, renderMarkdown } from "../markdown/render.ts";
import { combineSummaryAndBody } from "../markdown/table.ts";
import { UNAUTHORIZED_MCP, buildMcpServer } from "../mcp/server.ts";
import { cookieHeader, readCookie } from "./cookies.ts";
import type { AuthServerEndpoints } from "./discovery.ts";
import { addItemPage, editPage, errorPage, itemPage, librariesPage, libraryPage, loginPage } from "./pages.ts";
import { newPkceVerifier, pkceChallenge, readHandshake, signHandshake } from "./pkce.ts";

const SESSION_COOKIE = "mpos_session";
const OAUTH_COOKIE = "mpos_oauth";
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../../public");

function setCookies(res: Response, headers: string[]): void {
  res.setHeader("Set-Cookie", headers);
}

function formString(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

async function sessionAccess(req: Request, config: AppConfig): Promise<(Access & { csrf: string }) | undefined> {
  const token = readCookie(req.headers, SESSION_COOKIE);
  if (!token) return undefined;
  const session = await readSession(token, config.sessionSecret);
  if (!session) return undefined;
  return { ...accessFromIdentity(session), csrf: session.csrf };
}

function requireCsrf(req: Request, csrf: string): boolean {
  const fromForm = formString(req.body, "csrf");
  const fromHeader = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : "";
  const provided = fromForm || fromHeader;
  return Boolean(provided) && provided === csrf;
}

function parseItem(body: unknown) {
  return itemInputSchema.safeParse({
    name: formString(body, "name"),
    body: combineSummaryAndBody(
      formString(body, "summary"),
      [formString(body, "body"), formString(body, "description")].filter((part) => part.trim()).join("\n\n"),
    ),
    labels: parseLabelField(formString(body, "labels")),
  });
}

function libraryTemplateFromForm(value: string): LibraryTemplate {
  if (value === "policy" || value === "procedure") return value;
  return "general";
}

function parseLibraryItem(body: unknown, template: LibraryTemplate) {
  if (template === "general") return parseItem(body);
  const saved = itemForLibrary(template, {
    name: formString(body, "name"),
    summary: formString(body, "summary"),
    owner: formString(body, "owner"),
    approved_by: formString(body, "approved_by"),
    version: formString(body, "version"),
    effective_date: formString(body, "effective_date"),
    review_date: formString(body, "review_date"),
    purpose: formString(body, "purpose"),
    scope: formString(body, "scope"),
    policy: formString(body, "policy"),
    responsibilities: formString(body, "responsibilities"),
    exceptions: formString(body, "exceptions"),
    references: formString(body, "references"),
    related_policy: formString(body, "related_policy"),
    when_to_use: formString(body, "when_to_use"),
    steps: formString(body, "steps"),
    who: formString(body, "who"),
    labels: parseLabelField(formString(body, "labels")),
  });
  if (!saved.ok) {
    return { success: false as const, error: { issues: [{ message: saved.message }] } };
  }
  return { success: true as const, data: saved.item };
}

export function createApp(input: {
  config: AppConfig;
  db: Database;
  authServer: AuthServerEndpoints;
  verifierKey?: Parameters<typeof createTokenVerifier>[0]["localKey"];
  mountAuthServer?: (app: express.Express) => void;
}) {
  const { config, db, authServer } = input;
  const resourceUrl = new URL(config.mcpResourceUrl);
  const verifier = createTokenVerifier({
    issuer: config.authIssuer,
    audience: config.authAudience,
    jwksUrl: config.authJwksUrl,
    localKey: input.verifierKey,
  });
  const mcpHandler = createMcpHandler(({ authInfo }) => {
    if (!authInfo) {
      throw new Error("MCP handler invoked without authInfo");
    }
    return buildMcpServer(db, authInfo);
  });
  const nodeMcp = toNodeHandler(mcpHandler);
  const authGate = requireBearerAuth({
    verifier,
    requiredScopes: ["records.read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  const originHost = new URL(config.publicBaseUrl).hostname;
  const resourceHost = new URL(config.mcpResourceUrl).hostname;
  // Hostnames only. A full URL here makes the SDK reject the browser Host header.
  // The Railway hostname must be listed or the public site returns Invalid Host.
  const allowedNames = [
    ...new Set(
      [config.bindHost, originHost, resourceHost, "127.0.0.1", "localhost", "[::1]"].filter(
        (name) => name.length > 0,
      ),
    ),
  ];
  const app = createMcpExpressApp({
    host: config.bindHost,
    allowedHosts: allowedNames,
    allowedOrigins: allowedNames,
  });
  app.use(express.urlencoded({ extended: false }));

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: authServer.metadata,
      resourceServerUrl: resourceUrl,
      resourceName: "Mpos",
      scopesSupported: ["openid", "mpos:readonly", "mpos:edit"],
    }),
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

  app.get("/login", async (_req, res) => {
    const state = crypto.randomUUID();
    const verifierPkce = newPkceVerifier();
    const challenge = await pkceChallenge(verifierPkce);
    const handshake = await signHandshake({ state, verifier: verifierPkce }, config.sessionSecret);
    const authorize = new URL(authServer.authorizationEndpoint);
    authorize.searchParams.set("client_id", config.webClientId);
    authorize.searchParams.set("redirect_uri", `${config.publicBaseUrl}/callback`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid mpos:readonly mpos:edit");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", config.mcpResourceUrl);
    setCookies(res, [cookieHeader(OAUTH_COOKIE, handshake, { maxAge: 600 })]);
    res.redirect(authorize.toString());
  });

  app.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const handshakeToken = readCookie(req.headers, OAUTH_COOKIE);
    const handshake = handshakeToken
      ? await readHandshake(handshakeToken, config.sessionSecret)
      : undefined;
    if (!code || !handshake || handshake.state !== state) {
      res.status(400).send(errorPage("Sign-in failed (state mismatch). Try again."));
      return;
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.publicBaseUrl}/callback`,
      client_id: config.webClientId,
      code_verifier: handshake.verifier,
      resource: config.mcpResourceUrl,
    });
    const tokenRes = await fetch(authServer.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenRes.ok || !tokenJson.access_token) {
      res.status(401).send(errorPage("The identity provider did not issue an access token."));
      return;
    }
    let authInfo;
    try {
      authInfo = await verifier.verifyAccessToken(tokenJson.access_token);
    } catch {
      res
        .status(403)
        .send(errorPage("Signed in, but this account has no Mpos role (read-only or edit)."));
      return;
    }
    const extra = (authInfo.extra ?? {}) as { sub?: string; role?: Role };
    const csrf = crypto.randomUUID();
    const session = await signSession(
      {
        sub: extra.sub ?? authInfo.clientId,
        clientId: authInfo.clientId,
        role: extra.role ?? "readonly",
        csrf,
      },
      config.sessionSecret,
    );
    setCookies(res, [
      cookieHeader(SESSION_COOKIE, session, { maxAge: 60 * 60 }),
      cookieHeader(OAUTH_COOKIE, "", { clear: true }),
    ]);
    res.redirect("/");
  });

  app.get("/logout", (_req, res) => {
    setCookies(res, [cookieHeader(SESSION_COOKIE, "", { clear: true })]);
    if (authServer.endSessionEndpoint) {
      const logout = new URL(authServer.endSessionEndpoint);
      logout.searchParams.set("client_id", config.webClientId);
      logout.searchParams.set("post_logout_redirect_uri", config.publicBaseUrl);
      res.redirect(logout.toString());
      return;
    }
    res.redirect("/");
  });

  app.get("/", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.send(loginPage());
      return;
    }
    const libraries = await listLibraries(db);
    res.send(librariesPage({ access, csrf: access.csrf, libraries }));
  });

  app.post("/libraries", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot add libraries with this account."));
      return;
    }
    const template = libraryTemplateFromForm(formString(req.body, "template"));
    const parsed = libraryInputSchema.safeParse({ name: formString(req.body, "name") });
    if (!parsed.success) {
      const libraries = await listLibraries(db);
      res.status(400).send(
        librariesPage({
          access,
          csrf: access.csrf,
          libraries,
          error: parsed.error.issues[0]?.message ?? "Invalid library",
        }),
      );
      return;
    }
    const row = await createLibrary(db, parsed.data.name, access.sub, template);
    await writeAudit(db, { actorSub: access.sub, tool: "ui.create_library", success: true, detail: row.id });
    res.redirect(`/libraries/${row.id}`);
  });

  app.get("/libraries/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const library = await getLibrary(db, req.params.id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const items = await listItems(
      db,
      { library_id: library.id, q, limit: 50 },
      { publishedOnly: access.role === "readonly" },
    );
    res.send(libraryPage({ access, csrf: access.csrf, library, items, q }));
  });

  app.post("/libraries/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf) || !can(access, "records.delete")) {
      res.status(403).send(errorPage("You cannot delete libraries with this account."));
      return;
    }
    const library = await getLibrary(db, req.params.id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    try {
      const removed = await deleteLibrary(db, library.id);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: removed,
        detail: library.id,
      });
      res.redirect("/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete this library";
      const items = await listItems(db, { library_id: library.id, limit: 50 }, { publishedOnly: false });
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: false,
        detail: library.id,
      });
      res.status(400).send(
        libraryPage({
          access,
          csrf: access.csrf,
          library,
          items,
          error: message,
        }),
      );
    }
  });

  app.get("/libraries/:id/items/new", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "records.write")) {
      res.status(403).send(errorPage("Read-only accounts cannot add items."));
      return;
    }
    const library = await getLibrary(db, req.params.id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    res.send(addItemPage({ access, csrf: access.csrf, library }));
  });

  app.post("/libraries/:id/items", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot add items with this account."));
      return;
    }
    const library = await getLibrary(db, req.params.id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const parsed = parseLibraryItem(req.body, library.template);
    if (!parsed.success) {
      res.status(400).send(
        addItemPage({
          access,
          csrf: access.csrf,
          library,
          error: parsed.error.issues[0]?.message ?? "Invalid item",
        }),
      );
      return;
    }
    const row = await createItem(db, parsed.data, access.sub, library.id);
    await writeAudit(db, { actorSub: access.sub, tool: "ui.create", success: true, detail: row.id });
    res.redirect(`/items/${row.id}`);
  });

  app.get("/items/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const libraryId = typeof req.query.library === "string" ? req.query.library : undefined;
    const record = await getItem(db, req.params.id, {
      publishedOnly: access.role === "readonly",
      libraryId,
    }).catch(() => undefined);
    if (!record) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const library = await getLibrary(db, record.library_id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const structured = record.policy
      ? { control: policyControl(record.policy), parts: policyBody(record.policy) }
      : record.procedure
        ? { control: procedureControl(record.procedure), parts: procedureBody(record.procedure) }
        : undefined;
    const html = structured ? "" : await renderMarkdown(record.body);
    const control = structured?.control;
    const sections = structured
      ? await Promise.all(
          structured.parts.map(async (part) => ({
            heading: part.label,
            html: await renderMarkdown(part.text),
          })),
        )
      : undefined;
    res.send(itemPage({ access, csrf: access.csrf, item: record, library, html, control, sections }));
  });

  app.get("/items/:id/edit", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "records.write")) {
      res.status(403).send(errorPage("Read-only accounts cannot edit items."));
      return;
    }
    const record = await getItem(db, req.params.id, { publishedOnly: false });
    if (!record) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const library = await getLibrary(db, record.library_id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    res.send(editPage({ access, csrf: access.csrf, item: record, library }));
  });

  app.post("/items/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot edit items with this account."));
      return;
    }
    const record = await getItem(db, req.params.id, { publishedOnly: false });
    if (!record) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const library = await getLibrary(db, record.library_id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const parsed = parseLibraryItem(req.body, library.template);
    if (!parsed.success) {
      res.status(400).send(
        editPage({
          access,
          csrf: access.csrf,
          item: record,
          library,
          error: parsed.error.issues[0]?.message ?? "Invalid item",
        }),
      );
      return;
    }
    const row = await updateItem(db, req.params.id, parsed.data, access.sub);
    if (!row) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    await writeAudit(db, { actorSub: access.sub, tool: "ui.update", success: true, detail: row.id });
    res.redirect(`/items/${row.id}`);
  });

  app.post("/items/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf) || !can(access, "records.delete")) {
      res.status(403).send(errorPage("You cannot delete items with this account."));
      return;
    }
    const existing = await getItem(db, req.params.id, { publishedOnly: false });
    const libraryId = existing?.library_id;
    const removed = await deleteItem(db, req.params.id);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.delete",
      success: removed,
      detail: req.params.id,
    });
    res.redirect(libraryId ? `/libraries/${libraryId}` : "/");
  });

  app.get("/notes/:id/edit", (req, res) => {
    res.redirect(`/items/${req.params.id}/edit`);
  });
  app.get("/notes/:id", (req, res) => {
    res.redirect(`/items/${req.params.id}`);
  });

  app.post("/preview", express.json({ limit: "200kb" }), async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const markdown = formString(req.body, "markdown") || (req.body?.markdown as string) || "";
    const html = await renderMarkdown(typeof markdown === "string" ? markdown : "");
    res.json({ html });
  });

  app.post("/convert-html", express.json({ limit: "200kb" }), async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    res.json({ markdown: htmlToMarkdown(html) });
  });

  // Cursor lists tools from the last handshake. A 401/timeout is "not signed in",
  // not "the libraries are empty" — spell that out on the wire.
  app.all(
    "/mcp",
    (req, res, next) => {
      const sendJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode === 401 && body && typeof body === "object" && !Array.isArray(body)) {
          return sendJson({ ...(body as Record<string, unknown>), error_description: UNAUTHORIZED_MCP });
        }
        return sendJson(body);
      }) as typeof res.json;
      authGate(req, res, next);
    },
    (req, res) => {
      void nodeMcp(req, res, req.body);
    },
  );

  return app;
}
