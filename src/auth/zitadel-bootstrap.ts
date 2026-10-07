/**
 * Creates the MCPEncode project in local Zitadel.
 * Safe to run again: an existing project, its roles, apps, and demo users stay,
 * and redirect URIs are refreshed.
 *
 * Zitadel writes an admin personal access token only on first database init.
 * Run `docker compose up -d` before this script.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { oidcLoginScopes } from "./scopes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const zitadelPort = process.env.ZITADEL_HOST_PORT?.trim() || "8080";
const issuer = (process.env.ZITADEL_ISSUER?.trim() || `http://127.0.0.1:${zitadelPort}`).replace(
  /\/$/,
  "",
);
const publicBase = (process.env.PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "");
const projectName = "MCPEncode";
const webAppName = "MCPEncode web";
const agentAppName = "MCPEncode agent";

const agentRedirects = [
  "http://localhost:8787/callback",
  "http://127.0.0.1:8765/oauth/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
];

type Json = Record<string, unknown>;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function asRecord(value: unknown): Json | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Json;
}

function asList(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Json => Boolean(asRecord(entry)));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // Issuer is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} was not ready. Check \`docker compose ps\` and \`docker compose logs zitadel-api\`.`);
}

function readPat(): string {
  const file = path.join(root, "data/zitadel-bootstrap/admin.pat");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  }
  try {
    return execFileSync(
      "docker",
      ["compose", "exec", "-T", "zitadel-api", "cat", "/zitadel/bootstrap/admin.pat"],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

async function zitadel(pat: string, method: string, urlPath: string, body?: Json): Promise<Json> {
  const response = await fetch(`${issuer}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} failed (${response.status}): ${raw.slice(0, 600)}`);
  }
  return asRecord(parsed) ?? {};
}

function resultList(payload: Json): Json[] {
  return asList(payload.result);
}

async function ensureProject(pat: string): Promise<string> {
  const found = await zitadel(pat, "POST", "/management/v1/projects/_search", {
    queries: [{ nameQuery: { name: projectName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
  });
  const existing = resultList(found).find((project) => text(project.name) === projectName);
  const id = text(existing?.id);
  if (id) {
    await zitadel(pat, "PUT", `/management/v1/projects/${id}`, {
      name: projectName,
      projectRoleAssertion: true,
      projectRoleCheck: true,
    });
    return id;
  }
  const created = await zitadel(pat, "POST", "/management/v1/projects", {
    name: projectName,
    projectRoleAssertion: true,
    projectRoleCheck: true,
  });
  const createdId = text(created.id);
  if (!createdId) throw new Error("Zitadel created a project without an id");
  return createdId;
}

async function ensureRoles(pat: string, projectId: string): Promise<void> {
  const listed = await zitadel(pat, "POST", `/management/v1/projects/${projectId}/roles/_search`, {
    queries: [],
  });
  const keys = new Set(resultList(listed).map((role) => text(role.key) || text(role.roleKey)));
  const wanted = [
    { roleKey: "mpos-editor", displayName: "Edit" },
    { roleKey: "mpos-readonly", displayName: "Read-only" },
  ];
  for (const role of wanted) {
    if (keys.has(role.roleKey)) continue;
    await zitadel(pat, "POST", `/management/v1/projects/${projectId}/roles`, role);
  }
}

function clientIdOf(app: Json): string {
  const oidc = asRecord(app.oidcConfig);
  return text(oidc?.clientId) || text(app.clientId);
}

function oidcBody(input: {
  name?: string;
  redirects: string[];
  postLogout: string[];
  appType: string;
  skipNativeAppSuccessPage: boolean;
}): Json {
  return {
    ...(input.name ? { name: input.name } : {}),
    redirectUris: input.redirects,
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
    appType: input.appType,
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
    postLogoutRedirectUris: input.postLogout,
    version: "OIDC_VERSION_1_0",
    devMode: true,
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    accessTokenRoleAssertion: true,
    idTokenRoleAssertion: true,
    idTokenUserinfoAssertion: false,
    skipNativeAppSuccessPage: input.skipNativeAppSuccessPage,
  };
}

async function ensureApp(
  pat: string,
  projectId: string,
  input: {
    name: string;
    redirects: string[];
    postLogout: string[];
    appType: string;
    skipNativeAppSuccessPage: boolean;
  },
): Promise<string> {
  const listed = await zitadel(pat, "POST", `/management/v1/projects/${projectId}/apps/_search`, {
    queries: [],
  });
  const existing = resultList(listed).find((app) => text(app.name) === input.name);
  const body = oidcBody(input);
  if (!existing) {
    try {
      const created = await zitadel(pat, "POST", `/management/v1/projects/${projectId}/apps/oidc`, body);
      const clientId = text(created.clientId);
      if (!clientId) throw new Error(`Zitadel created ${input.name} without a client id`);
      return clientId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const custom = input.redirects.find((uri) => uri.startsWith("cursor:"));
      if (!custom || !message.includes("400")) throw error;
      console.log(`${input.name}: Zitadel rejected ${custom}. Registering the http callbacks only.`);
      const created = await zitadel(pat, "POST", `/management/v1/projects/${projectId}/apps/oidc`, {
        ...body,
        redirectUris: input.redirects.filter((uri) => uri !== custom),
      });
      const clientId = text(created.clientId);
      if (!clientId) throw new Error(`Zitadel created ${input.name} without a client id`);
      return clientId;
    }
  }
  const appId = text(existing.id);
  if (!appId) throw new Error(`${input.name} is missing an application id`);
  try {
    await zitadel(pat, "PUT", `/management/v1/projects/${projectId}/apps/${appId}/oidc_config`, {
      ...body,
      name: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Zitadel returns this when the application already matches.
    if (!message.includes("No changes")) throw error;
  }
  const clientId = clientIdOf(existing);
  if (clientId) return clientId;
  const fetched = await zitadel(pat, "GET", `/management/v1/projects/${projectId}/apps/${appId}`);
  const fromApp = clientIdOf(asRecord(fetched.app) ?? fetched);
  if (!fromApp) throw new Error(`${input.name} has no client id`);
  return fromApp;
}

async function organizationId(pat: string, projectId: string): Promise<string> {
  const project = await zitadel(pat, "GET", `/management/v1/projects/${projectId}`);
  const details = asRecord(project.project) ?? project;
  const owner =
    text(asRecord(details.details)?.resourceOwner) ||
    text(asRecord(project.details)?.resourceOwner);
  if (!owner) throw new Error("Zitadel project is missing an organization id");
  return owner;
}

/**
 * Login V2 only signs in users created by the v2 API. The older management
 * API leaves them in the initial state, which the login page refuses.
 */
async function ensureHuman(
  pat: string,
  input: { userName: string; lastName: string; email: string; password: string; roleKey: string },
  projectId: string,
  orgId: string,
): Promise<void> {
  const found = await zitadel(pat, "POST", "/management/v1/users/_search", {
    queries: [{ userNameQuery: { userName: input.userName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
  });
  let user = resultList(found).find((entry) => text(entry.userName) === input.userName);
  let userId = text(user?.id) || text(user?.userId);
  if (userId) {
    const current = await zitadel(pat, "GET", `/v2/users/${userId}`);
    const state = text(asRecord(current.user)?.state) || text(current.state);
    if (state === "USER_STATE_INITIAL") {
      await zitadel(pat, "DELETE", `/v2/users/${userId}`);
      user = undefined;
      userId = "";
    }
  }
  if (!userId) {
    const created = await zitadel(pat, "POST", "/v2/users/new", {
      organizationId: orgId,
      username: input.userName,
      human: {
        profile: { givenName: "MCPEncode", familyName: input.lastName, displayName: input.lastName },
        email: { email: input.email, isVerified: true },
        password: { password: input.password, changeRequired: false },
      },
    });
    userId = text(created.id) || text(created.userId);
  }
  if (!userId) throw new Error(`Zitadel user ${input.userName} has no id`);
  const grants = await zitadel(pat, "POST", "/management/v1/users/grants/_search", {
    queries: [{ userIdQuery: { userId } }],
  });
  const already = resultList(grants).some((grant) => {
    const grantProject = text(grant.projectId);
    if (grantProject && grantProject !== projectId) return false;
    const keys = Array.isArray(grant.roleKeys)
      ? grant.roleKeys.filter((role): role is string => typeof role === "string")
      : [];
    return keys.includes(input.roleKey);
  });
  if (already) return;
  await zitadel(pat, "POST", `/management/v1/users/${userId}/grants`, {
    projectId,
    roleKeys: [input.roleKey],
  });
}

function upsertEnv(updates: Record<string, string>): void {
  const file = path.join(root, ".env");
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = raw.length ? raw.split("\n") : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  const textOut = next.join("\n").replace(/\n*$/, "\n");
  writeFileSync(file, textOut);
}

function writeMcpClient(clientId: string, projectId: string): void {
  const file = path.join(root, ".cursor/mcp.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    mcpServers?: { publisher?: { auth?: { CLIENT_ID?: string; scopes?: string[] } } };
  };
  const auth = parsed.mcpServers?.publisher?.auth;
  if (!auth) throw new Error(".cursor/mcp.json has no publisher auth block");
  auth.CLIENT_ID = clientId;
  auth.scopes = oidcLoginScopes(projectId);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function main(): Promise<void> {
  const editorPassword = requiredEnv("ZITADEL_EDITOR_PASSWORD");
  const readerPassword = requiredEnv("ZITADEL_READER_PASSWORD");
  await waitFor("Zitadel discovery", async () => {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    return response.ok;
  });
  await waitFor("Zitadel admin token", async () => Boolean(readPat()));
  const pat = readPat();
  if (!pat) {
    throw new Error(
      "Zitadel did not write data/zitadel-bootstrap/admin.pat. That file is created only on the first database init. If the database volume already existed, remove the zitadel volume and data/zitadel-bootstrap, then start compose again.",
    );
  }
  const projectId = await ensureProject(pat);
  await ensureRoles(pat, projectId);
  const webClientId = await ensureApp(pat, projectId, {
    name: webAppName,
    redirects: [`${publicBase}/callback`],
    postLogout: [publicBase],
    appType: "OIDC_APP_TYPE_USER_AGENT",
    skipNativeAppSuccessPage: false,
  });
  const agentClientId = await ensureApp(pat, projectId, {
    name: agentAppName,
    redirects: agentRedirects,
    postLogout: [],
    appType: "OIDC_APP_TYPE_NATIVE",
    skipNativeAppSuccessPage: true,
  });
  const orgId = await organizationId(pat, projectId);
  await ensureHuman(
    pat,
    {
      userName: "editor",
      lastName: "Editor",
      email: "editor@mcpencode.local",
      password: editorPassword,
      roleKey: "mpos-editor",
    },
    projectId,
    orgId,
  );
  await ensureHuman(
    pat,
    {
      userName: "reader",
      lastName: "Reader",
      email: "reader@mcpencode.local",
      password: readerPassword,
      roleKey: "mpos-readonly",
    },
    projectId,
    orgId,
  );
  upsertEnv({
    AUTH_MODE: "oidc",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: projectId,
    WEB_CLIENT_ID: webClientId,
    MCP_CLIENT_ID: agentClientId,
  });
  writeMcpClient(agentClientId, projectId);
  console.log(`Zitadel project ${projectId}`);
  console.log(`Web client ${webClientId}`);
  console.log(`Agent client ${agentClientId}`);
  console.log("Wrote AUTH_MODE, AUTH_ISSUER, AUTH_AUDIENCE, WEB_CLIENT_ID, and MCP_CLIENT_ID to .env");
  console.log(`Sign in to the publisher as editor or reader. Admin console: ${issuer}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
