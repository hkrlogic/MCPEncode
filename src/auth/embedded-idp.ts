/**
 * Identity provider that runs inside the app.
 * Accounts are loaded from the store. There is no shared demo password.
 *
 * Clients register (RFC 7591) and get their own client_id, tied to the
 * callbacks they registered. Every MCP sign-in ends on a consent page that
 * names the client, the callback host and the library. Refresh tokens rotate;
 * an already-used one revokes its whole chain. Clients, refresh chains and the
 * signing key live in the IdpStore (Postgres in production).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { DEFAULT_REFRESH_MAX_DAYS, type AppConfig } from "../config.ts";
import type { AuthServerEndpoints } from "../http/discovery.ts";
import { cookieHeader, readCookie } from "../http/cookies.ts";
import { pkceChallenge } from "../http/pkce.ts";
import { staticUrl } from "../http/static-assets.ts";
import type { AccountStore } from "./accounts.ts";
import {
  hashRefreshToken,
  memoryIdpStore,
  newClientId,
  newRefreshToken,
  type IdpStore,
  type SigningKeyRecord,
} from "./idp-store.ts";
import { hashPassword, needsRehash, normalizeUsername, verifyPassword } from "./passwords.ts";
import { newSetupCode, setupCodeMatches } from "./setup-code.ts";
import { QueueFullError } from "./semaphore.ts";
import { addressKey, type KnownGoodStore, SIGN_IN_BUSY, SIGN_IN_WAIT, SignInLimit } from "./signin-limit.ts";
import {
  callbackHost,
  callbackKind,
  callbackLabel,
  DEFAULT_ALLOWED_SCHEMES,
  isAllowedCallback,
  redirectMatches,
} from "./redirect.ts";
import type { Role } from "./rbac.ts";

type AuthCode = {
  sub: string;
  role: Role;
  realmRole: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  nonce: string;
  expiresAt: number;
};

/** A signed-in person who has not yet answered the consent page. */
type PendingConsent = Omit<AuthCode, "expiresAt"> & {
  state: string;
  /** Double-submit value: the consent cookie must carry the same. */
  browserKey: string;
  expiresAt: number;
};

/** The client_id every MCP client was handed before registrations were stored. */
export const LEGACY_CLIENT_ID = "mpos-mcp";

/** A refresh token unused this long expires, even inside the chain's maximum lifetime. */
const REFRESH_IDLE_MS = 12 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
/** Registrations that never completed a sign-in are dropped after this (OAUTH_PENDING_CLIENT_TTL_MINUTES). */
const DEFAULT_PENDING_CLIENT_TTL_MINUTES = 60;
const DEFAULT_MAX_PENDING_PER_ADDRESS = 20;
const CONSENT_COOKIE = "mpos_consent";
const MAX_REDIRECT_URIS = 8;
const REGISTER_BODY_LIMIT = "8kb";
/** How often unused registrations are swept, besides on each registration. */
const CLIENT_SWEEP_MS = 60 * 60 * 1000;

function scopeFor(realmRole: string): string {
  return realmRole === "mpos-editor" ? "openid mpos:edit mpos:sa" : "openid mpos:readonly";
}

type VerifyKey = Awaited<ReturnType<typeof importJWK>>;

export type EmbeddedIdp = {
  endpoints: AuthServerEndpoints;
  /** Public half of the persisted signing key, for verifying tokens in this process. */
  publicKey: VerifyKey;
  /** Key id in the token header and on /id/jwks. */
  kid: string;
  mount: (app: Express) => void;
  /** Sign this account out everywhere: refresh chains, sessions and access tokens. */
  revokeAccount: (sub: string) => Promise<void>;
};

export type EmbeddedIdpOptions = {
  signInLimit?: SignInLimit;
  /** Keeps the sign-in throttle's known-good addresses across restarts (ignored when signInLimit is given). */
  knownGoodStore?: KnownGoodStore;
  /** Clients, refresh chains and the signing key. Defaults to memory (tests). */
  store?: IdpStore;
  /** Library name for the consent page. */
  libraryName?: (libraryId: string) => Promise<string | undefined>;
};

type ResolvedClient =
  | { kind: "web"; clientId: string; name: string }
  | { kind: "legacy"; clientId: string; name: string }
  | { kind: "registered"; clientId: string; name: string; selfDeclared: boolean; redirectUris: string[] };

function q(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === "string" ? value : "";
}

/** Browser address for the sign-in limit. Express fills req.ip from the socket, or from a trusted proxy. */
function clientAddress(req: Request): string {
  const raw = req.ip || req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/, "") || "unknown";
}

function form(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** client_name from a registration: printable, trimmed, short. Shown on the consent page (escaped). */
function cleanClientName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
}

const LIBRARY_RESOURCE_PATH =
  /^\/libraries\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/mcp(?:\/[A-Za-z0-9_-]{32,64})?$/i;

/**
 * The token audience a client may ask for: this app's own login, or one of this
 * app's library MCP links. Anything else is refused, so a sign-in link cannot
 * mint a token addressed to some other service.
 */
function resourceAllowed(resource: string, config: AppConfig): boolean {
  if (resource === config.authAudience) return true;
  return resourceLibraryId(resource, config) !== undefined;
}

/** Library id in a library MCP resource on this origin. */
function resourceLibraryId(resource: string, config: AppConfig): string | undefined {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  if (url.search || url.hash || url.username || url.password) return undefined;
  if (url.origin !== new URL(config.publicBaseUrl).origin) return undefined;
  return LIBRARY_RESOURCE_PATH.exec(url.pathname)?.[1]?.toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginPage(input: {
  error?: string;
  hidden: Record<string, string>;
  /** No accounts yet: this form creates the first one. There is no shared password. */
  setup: boolean;
  /** Public deployment: creating the first account also takes the operator's setup code. */
  setupCodeRequired?: boolean;
  /** Where the browser goes after sign-in, shown before the password is typed. Omitted for the publisher's own sign-in. */
  returnTo?: string;
  username?: string;
}): string {
  const fields = Object.entries(input.hidden)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const title = input.setup ? "Create account" : "Sign in";
  const lead = input.setup
    ? input.setupCodeRequired
      ? "This is the first account. It is SA — it can manage people and every library. Enter the setup code: SETUP_TOKEN from your .env (scripts/init-env.sh made one), or the one-time code in the server log. Then choose a username and a password of at least 12 characters."
      : "This is the first account. It is SA — it can manage people and every library. Choose a username and a password of at least 12 characters."
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · MCPEncode</title>
  <link rel="stylesheet" href="${staticUrl("styles.css")}">
</head>
<body>
  <main class="sign-in">
    <section class="panel">
      <h1>${title}</h1>
      ${lead ? `<p class="hint">${lead}</p>` : ""}
      ${
        input.returnTo
          ? `<p class="hint">After you sign in, you will be sent to <strong>${escapeHtml(input.returnTo)}</strong>. Continue only if you started this from an app you trust.</p>`
          : ""
      }
      ${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ""}
      <form method="post" action="/id/authorize">
        ${fields}
        ${
          input.setup && input.setupCodeRequired
            ? `<label>Setup code <input name="setup_code" autocomplete="off" required maxlength="200"></label>`
            : ""
        }
        <label>Username <input name="username" autocomplete="username" required maxlength="64" value="${escapeHtml(input.username ?? "")}"></label>
        <label>Password <input name="password" type="password" autocomplete="${input.setup ? "new-password" : "current-password"}" required></label>
        ${
          input.setup
            ? `<label>Confirm password <input name="password_confirm" type="password" autocomplete="new-password" required></label>`
            : ""
        }
        <button class="btn" type="submit">${input.setup ? "Create account" : "Continue"}</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

/** After sign-in, before any code is issued: who is asking, where the code goes, and for which library. */
function consentPage(input: {
  consentId: string;
  clientName: string;
  /** The name came from the client's own registration and nobody checked it. */
  selfDeclared: boolean;
  clientId: string;
  legacy: boolean;
  callbackHost: string;
  callback: string;
  library: string;
  username: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Allow access? · MCPEncode</title>
  <link rel="stylesheet" href="${staticUrl("styles.css")}">
</head>
<body>
  <main class="sign-in">
    <section class="panel">
      <h1>Allow access?</h1>
      <p>${
        input.selfDeclared
          ? `An app that says it is <strong>${escapeHtml(input.clientName)}</strong> (unverified: the app chose this name itself)`
          : `<strong>${escapeHtml(input.clientName)}</strong>`
      } wants to use your account <strong>${escapeHtml(input.username)}</strong> for <strong>${escapeHtml(input.library)}</strong>.</p>
      <p>If you allow it, the sign-in is sent to <strong>${escapeHtml(input.callbackHost)}</strong>.</p>
      <p class="hint">Full callback: <code>${escapeHtml(input.callback)}</code><br>Client id: ${escapeHtml(input.clientId)}</p>
      ${
        input.legacy
          ? `<p class="hint">This app connected before apps registered their own client id. Reconnect it to register; this shared id will be retired.</p>`
          : ""
      }
      <p class="hint">Allow only if you started this from an app you trust. It can do what your account can do in this library.</p>
      <form method="post" action="/id/consent">
        <input type="hidden" name="consent_id" value="${escapeHtml(input.consentId)}">
        <button class="btn" type="submit" name="decision" value="allow">Allow</button>
        <button class="btn secondary" type="submit" name="decision" value="deny">Deny</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

/**
 * In-process OAuth 2.1 authorization server. Issues audience-bound JWTs with
 * the same role claims the resource server already understands.
 */
function realmRoleFor(role: Role): string {
  // Keep the Zitadel-era claim name so existing verifiers still resolve SA.
  return role === "sa" ? "mpos-editor" : "mpos-readonly";
}

async function newSigningKey(): Promise<SigningKeyRecord> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  const privateJwk = (await exportJWK(privateKey)) as Record<string, unknown>;
  const kid = await calculateJwkThumbprint(publicJwk as JWK);
  return { kid, publicJwk, privateJwk, createdAt: Date.now() };
}

export async function createEmbeddedIdp(
  config: AppConfig,
  accounts: AccountStore,
  options?: EmbeddedIdpOptions,
): Promise<EmbeddedIdp> {
  // Used when the username is unknown so a miss still spends a scrypt verification.
  const dummyPasswordHash = await hashPassword(`unused-${crypto.randomUUID()}`);
  const signInLimit = options?.signInLimit ?? new SignInLimit({ knownGoodStore: options?.knownGoodStore });
  if (!options?.signInLimit) {
    await signInLimit.restore().catch((error: unknown) => {
      console.warn("Could not load known-good sign-in addresses:", error instanceof Error ? error.message : error);
    });
  }
  const unusedClientTtlMs = (config.oauthPendingClientTtlMinutes ?? DEFAULT_PENDING_CLIENT_TTL_MINUTES) * 60 * 1000;
  const maxPendingPerAddress = config.oauthMaxPendingClientsPerAddress ?? DEFAULT_MAX_PENDING_PER_ADDRESS;
  const store = options?.store ?? memoryIdpStore();
  const refreshMaxMs = (config.refreshMaxLifetimeDays ?? DEFAULT_REFRESH_MAX_DAYS) * 24 * 60 * 60 * 1000;
  const secureCookies = config.publicBaseUrl.startsWith("https://");
  // The first-account page needs a code only the operator has, wherever the
  // request seems to come from (a proxy on loopback makes everyone look local).
  // SETUP_TOKEN if set, otherwise a random one printed once to the log.
  // Only ALLOW_OPEN_SETUP=true (setupCodeRequired false) skips it.
  const setupCode = config.setupCodeRequired !== false ? (config.setupToken ?? newSetupCode()) : undefined;
  if (setupCode !== undefined && (await accounts.count()) === 0) {
    console.log(
      config.setupToken
        ? "No account exists yet. The create-account page asks for your SETUP_TOKEN."
        : `No account exists yet. First-account setup code: ${setupCode}  (set SETUP_TOKEN to choose your own)`,
    );
  }
  // Persisted, so a restart keeps every issued token valid.
  const signing = await store.signingKey(newSigningKey);
  const kid = signing.kid;
  const privateKey = await importJWK(signing.privateJwk as JWK, "RS256");
  const publicKey = await importJWK(signing.publicJwk as JWK, "RS256");
  const jwk = { ...signing.publicJwk, kid, use: "sig", alg: "RS256" } as JWK;

  const issuer = config.authIssuer;
  // Codes and consent answers live a few minutes; memory is enough. A restart
  // in the middle of a sign-in only means signing in again.
  const codes = new Map<string, AuthCode>();
  const consents = new Map<string, PendingConsent>();
  let lastPrune = 0;

  const endpoints: AuthServerEndpoints = {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "mpos:readonly", "mpos:edit", "mpos:sa"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    endSessionEndpoint: `${issuer}/logout`,
  };

  const policy = {
    allowedHosts: config.oauthRedirectHosts,
    allowAnyHttps: config.oauthAllowAnyHttpsRedirect === true,
    allowedSchemes: config.oauthAllowedSchemes ?? DEFAULT_ALLOWED_SCHEMES,
  };
  const maxPendingClients = config.oauthMaxPendingClients ?? 1000;

  async function resolveClient(clientId: string): Promise<ResolvedClient | undefined> {
    if (!clientId) return undefined;
    if (clientId === config.webClientId) return { kind: "web", clientId, name: "MCPEncode" };
    if (clientId === LEGACY_CLIENT_ID) {
      return config.oauthLegacyClient === false
        ? undefined
        : { kind: "legacy", clientId, name: "MCP client (shared legacy id)" };
    }
    const found = await store.findClient(clientId);
    if (!found) return undefined;
    return {
      kind: "registered",
      clientId,
      name: found.clientName || "Unnamed MCP client",
      selfDeclared: Boolean(found.clientName),
      redirectUris: found.redirectUris,
    };
  }

  /** Exact registered callback, still allowed by the current policy. */
  function redirectAllowed(client: ResolvedClient, uri: string): boolean {
    if (client.kind === "web") {
      return isAllowedCallback(uri, {
        clientId: client.clientId,
        webClientId: config.webClientId,
        publicBaseUrl: config.publicBaseUrl,
      });
    }
    if (client.kind === "legacy") {
      // Never registered a callback, so anyone can use this id with any
      // callback the policy accepts. Keep it to loopback, an operator-listed
      // host, or a known app's own single-word scheme (cursor:, vscode:, ...),
      // which only that app receives. No reverse-DNS schemes, never any-https.
      const kind = callbackKind(uri, { allowedHosts: policy.allowedHosts, allowedSchemes: policy.allowedSchemes });
      if (kind === "loopback" || kind === "listed-host") return true;
      if (kind !== "custom-scheme") return false;
      const scheme = new URL(uri).protocol.slice(0, -1).toLowerCase();
      return policy.allowedSchemes.includes(scheme);
    }
    return redirectMatches(uri, client.redirectUris) && callbackKind(uri, policy) !== undefined;
  }

  async function prune(now: number): Promise<void> {
    for (const [key, code] of codes) if (code.expiresAt < now) codes.delete(key);
    for (const [key, consent] of consents) if (consent.expiresAt < now) consents.delete(key);
    if (now - lastPrune < 60_000) return;
    lastPrune = now;
    await store.pruneRefresh(now - refreshMaxMs);
  }

  async function issueRefreshToken(input: {
    sub: string;
    clientId: string;
    resource: string;
    /** Continue this chain (refresh). Omit to start a new one (sign-in). */
    chain?: { chainId: string; chainStartedAt: number };
  }): Promise<string> {
    const now = Date.now();
    await prune(now);
    const chain = input.chain ?? { chainId: crypto.randomUUID(), chainStartedAt: now };
    const token = newRefreshToken();
    await store.insertRefresh({
      tokenHash: hashRefreshToken(token),
      chainId: chain.chainId,
      sub: input.sub,
      clientId: input.clientId,
      resource: input.resource,
      chainStartedAt: chain.chainStartedAt,
      // Idle expiry, but never past the chain's absolute end.
      expiresAt: Math.min(now + REFRESH_IDLE_MS, chain.chainStartedAt + refreshMaxMs),
      usedAt: null,
    });
    return token;
  }

  async function issueAccessToken(input: {
    sub: string;
    realmRole: string;
    clientId: string;
    resource: string;
  }): Promise<string> {
    const scope = scopeFor(input.realmRole);
    return new SignJWT({
      sub: input.sub,
      azp: input.clientId,
      scope,
      realm_access: { roles: [input.realmRole] },
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(input.resource || config.authAudience)
      // Millisecond precision: sign-out compares iat with sessions_revoked_at
      // (ms), so a sign-in in the same second as a sign-out still counts as after it.
      .setIssuedAt(Date.now() / 1000)
      .setExpirationTime("15m")
      .sign(privateKey);
  }

  async function issueIdToken(input: { sub: string; clientId: string; nonce: string }): Promise<string> {
    const claims: Record<string, string> = {
      sub: input.sub,
      azp: input.clientId,
    };
    if (input.nonce) claims.nonce = input.nonce;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(input.clientId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  }

  /** Issue a code and send the browser back to the client. */
  function redirectWithCode(res: Response, grant: Omit<AuthCode, "expiresAt">, state: string): void {
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { ...grant, expiresAt: Date.now() + CODE_TTL_MS });
    const next = new URL(grant.redirectUri);
    next.searchParams.set("code", code);
    if (state) next.searchParams.set("state", state);
    res.redirect(next.toString());
  }

  async function libraryLabel(resource: string): Promise<string> {
    const libraryId = resourceLibraryId(resource, config);
    if (!libraryId) return "your MCPEncode account";
    const name = await options?.libraryName?.(libraryId).catch(() => undefined);
    return name ? `the library “${name}”` : `library ${libraryId}`;
  }

  // Registrations nobody used are swept every hour, not only when the next one arrives.
  const sweep = setInterval(() => {
    store.pruneClients(Date.now() - unusedClientTtlMs).catch((error: unknown) => {
      console.warn("Could not prune unused OAuth registrations:", error instanceof Error ? error.message : error);
    });
  }, CLIENT_SWEEP_MS);
  sweep.unref();

  /** Per-address limit for the unauthenticated OAuth endpoints. Undefined when turned off (0). */
  function addressLimit(
    limit: number | undefined,
    windowMs: number,
    identifier: string,
    send: (res: Response) => void,
  ): RequestHandler | undefined {
    if (!limit || limit <= 0) return undefined;
    return rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      identifier,
      // IPv6 grouped per /64 (one customer's prefix), IPv4 per address.
      ipv6Subnet: 64,
      validate: { xForwardedForHeader: false, forwardedHeader: false },
      handler: (_req, res, _next, options) => {
        res.status(options.statusCode);
        send(res);
      },
    });
  }
  const pass: RequestHandler = (_req, _res, next) => next();
  const registerLimit =
    addressLimit(config.oauthRegisterRateLimit ?? 20, 60 * 60 * 1000, "oauth-register", (res) => {
      res.json({ error: "too_many_requests", error_description: "Too many client registrations from this address. Wait and retry (see Retry-After)." });
    }) ?? pass;
  const authorizeLimit =
    addressLimit(config.oauthAuthorizeRateLimit ?? 60, 60 * 1000, "oauth-authorize", (res) => {
      res.type("text/plain").send("Too many sign-in requests from this address. Wait a minute and try again.");
    }) ?? pass;

  function mount(app: Express): void {
    app.get("/id/.well-known/openid-configuration", (_req, res) => {
      res.json(endpoints.metadata);
    });
    app.get("/id/.well-known/oauth-authorization-server", (_req, res) => {
      res.json(endpoints.metadata);
    });
    app.get("/id/jwks", (_req, res) => {
      res.json({ keys: [jwk] });
    });

    // Dynamic client registration (RFC 7591). Public clients only: PKCE, no secret.
    app.post("/id/register", registerLimit, express.json({ limit: REGISTER_BODY_LIMIT }), async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requested = body.redirect_uris;
      if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_REDIRECT_URIS) {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `Register 1 to ${MAX_REDIRECT_URIS} redirect_uris.`,
        });
        return;
      }
      const accepted: string[] = [];
      for (const entry of requested) {
        if (typeof entry !== "string" || callbackKind(entry, policy) === undefined) {
          res.status(400).json({
            error: "invalid_redirect_uri",
            error_description:
              "Callbacks must be loopback (http://127.0.0.1, http://[::1], http://localhost), a reverse-DNS app scheme (com.example.app:/callback) or a known app scheme (cursor, vscode, claude, or OAUTH_ALLOWED_SCHEMES). Browser-launcher schemes are refused. A remote https host must be listed in OAUTH_REDIRECT_HOSTS.",
          });
          return;
        }
        if (!accepted.includes(entry)) accepted.push(entry);
      }
      const authMethod = body.token_endpoint_auth_method;
      if (authMethod !== undefined && authMethod !== "none") {
        res.status(400).json({
          error: "invalid_client_metadata",
          error_description: "Only public clients are supported (token_endpoint_auth_method none, with PKCE).",
        });
        return;
      }
      const grantTypes = body.grant_types;
      if (
        grantTypes !== undefined &&
        (!Array.isArray(grantTypes) ||
          !grantTypes.every((grant) => grant === "authorization_code" || grant === "refresh_token"))
      ) {
        res.status(400).json({ error: "invalid_client_metadata", error_description: "Unsupported grant_types." });
        return;
      }
      const now = Date.now();
      await store.pruneClients(now - unusedClientTtlMs);
      if ((await store.countPendingClients(now - unusedClientTtlMs)) >= maxPendingClients) {
        console.warn("OAuth registration refused: the OAUTH_MAX_PENDING_CLIENTS limit of unused registrations is reached.");
        res.status(503).setHeader("Retry-After", "3600").json({
          error: "temporarily_unavailable",
          error_description: "Too many pending client registrations. Try again later.",
        });
        return;
      }
      const registeredFrom = createHash("sha256").update(addressKey(clientAddress(req))).digest("hex");
      if ((await store.countPendingClientsFrom(now - unusedClientTtlMs, registeredFrom)) >= maxPendingPerAddress) {
        res
          .status(429)
          .setHeader("Retry-After", String(Math.ceil(unusedClientTtlMs / 1000)))
          .json({
            error: "too_many_requests",
            error_description:
              "Too many unused client registrations from this address. Finish a sign-in with one you have, or wait (see Retry-After).",
          });
        return;
      }
      const client = {
        clientId: newClientId(),
        clientName: cleanClientName(body.client_name),
        redirectUris: accepted,
        createdAt: now,
        registeredFrom,
      };
      await store.saveClient(client);
      res.status(201).json({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(now / 1000),
        ...(client.clientName ? { client_name: client.clientName } : {}),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: accepted,
      });
    });

    type AuthorizeRequest = {
      client: ResolvedClient;
      hidden: Record<string, string>;
    };

    /** Validate the authorize parameters. Sends the error and returns undefined when they are bad. */
    const readAuthorize = async (req: Request, res: Response): Promise<AuthorizeRequest | undefined> => {
      const hidden = {
        client_id: form(req, "client_id") || q(req, "client_id"),
        redirect_uri: form(req, "redirect_uri") || q(req, "redirect_uri"),
        state: form(req, "state") || q(req, "state"),
        code_challenge: form(req, "code_challenge") || q(req, "code_challenge"),
        code_challenge_method: form(req, "code_challenge_method") || q(req, "code_challenge_method") || "S256",
        resource: form(req, "resource") || q(req, "resource") || config.authAudience,
        scope: form(req, "scope") || q(req, "scope"),
        nonce: form(req, "nonce") || q(req, "nonce"),
      };
      if (!hidden.client_id) {
        res.status(400).send("client_id is required");
        return undefined;
      }
      const client = await resolveClient(hidden.client_id);
      if (!client) {
        res.status(400).send("unknown client_id. Reconnect the app so it registers again.");
        return undefined;
      }
      // Never redirect to a callback that is not registered: show the error here.
      if (!redirectAllowed(client, hidden.redirect_uri)) {
        res.status(400).send("invalid redirect_uri");
        return undefined;
      }
      if (hidden.code_challenge_method !== "S256" || !hidden.code_challenge) {
        res.status(400).send("PKCE S256 is required");
        return undefined;
      }
      if (!resourceAllowed(hidden.resource, config)) {
        res.status(400).send("invalid resource");
        return undefined;
      }
      return { client, hidden };
    };

    const showAuthorize = async (req: Request, res: Response, error?: string, username?: string) => {
      const request = await readAuthorize(req, res);
      if (!request) return;
      const { client, hidden } = request;
      const setup = (await accounts.count()) === 0;
      res.send(
        loginPage({
          error,
          hidden,
          setup,
          setupCodeRequired: setup && setupCode !== undefined,
          returnTo: client.kind === "web" ? undefined : callbackLabel(hidden.redirect_uri),
          username,
        }),
      );
    };

    app.use("/id/authorize", authorizeLimit);
    app.get("/id/authorize", (req, res, next) => {
      showAuthorize(req, res).catch(next);
    });

    /**
     * Create the first account or check a password. Sends the form again with
     * an error and returns undefined when that fails; the attempt stays counted.
     */
    const checkSignIn = async (
      req: Request,
      res: Response,
      input: { username: string; password: string },
    ): Promise<{ sub: string; role: Role; realmRole: string; username: string } | undefined> => {
      const { username, password } = input;
      // Setup is decided by the account table, never by a form field. Once an
      // account exists, a late setup post is checked as an ordinary sign-in.
      const settingUp = (await accounts.count()) === 0;
      if (settingUp) {
        if (setupCode !== undefined && !setupCodeMatches(form(req, "setup_code"), setupCode)) {
          await showAuthorize(req, res, "That setup code is not correct.", username);
          return undefined;
        }
        if (password !== form(req, "password_confirm")) {
          await showAuthorize(req, res, "Those passwords do not match.", username);
          return undefined;
        }
        const created = await accounts.createFirst({ username, password });
        if (!created.ok) {
          await showAuthorize(req, res, created.message, username);
          return undefined;
        }
        return {
          sub: created.account.id,
          role: created.account.role,
          realmRole: realmRoleFor(created.account.role),
          username: created.account.username,
        };
      }
      const account = await accounts.findByUsername(username);
      const hash = account?.passwordHash ?? dummyPasswordHash;
      const match = await verifyPassword(password, hash);
      if (!account || !match) {
        await showAuthorize(req, res, "Unknown username or password.", username);
        return undefined;
      }
      if (account.disabled) {
        await showAuthorize(req, res, "This account is disabled.", username);
        return undefined;
      }
      // Hashes made with an older, cheaper setting are upgraded now that the
      // password is known. A failure here must not block sign-in.
      if (needsRehash(account.passwordHash)) {
        await accounts.setPassword(account.id, password).catch(() => undefined);
      }
      return {
        sub: account.id,
        role: account.role,
        realmRole: realmRoleFor(account.role),
        username: account.username,
      };
    };

    app.post("/id/authorize", async (req, res) => {
      const username = form(req, "username");
      const password = form(req, "password");
      const attemptKey = normalizeUsername(username) || "(blank)";
      const address = clientAddress(req);
      // Counted now, before any scrypt runs: parallel posts cannot slip under the limit.
      if (!signInLimit.begin(attemptKey, address)) {
        await showAuthorize(req, res, SIGN_IN_WAIT, username);
        return;
      }
      let user: { sub: string; role: Role; realmRole: string; username: string } | undefined;
      try {
        user = await checkSignIn(req, res, { username, password });
      } catch (error) {
        if (!(error instanceof QueueFullError)) throw error;
        await showAuthorize(req, res, SIGN_IN_BUSY, username);
        return;
      }
      if (!user) return;
      signInLimit.succeed(attemptKey, address);
      const request = await readAuthorize(req, res);
      if (!request) return;
      const { client, hidden } = request;
      const grant = {
        sub: user.sub,
        role: user.role,
        realmRole: user.realmRole,
        clientId: client.clientId,
        redirectUri: hidden.redirect_uri,
        challenge: hidden.code_challenge,
        resource: hidden.resource,
        nonce: hidden.nonce,
      };
      // The publisher's own sign-in returns to this app; there is nothing to consent to.
      if (client.kind === "web") {
        redirectWithCode(res, grant, hidden.state);
        return;
      }
      const now = Date.now();
      await prune(now);
      const consentId = randomBytes(32).toString("base64url");
      const browserKey = randomBytes(32).toString("base64url");
      consents.set(consentId, { ...grant, state: hidden.state, browserKey, expiresAt: now + CONSENT_TTL_MS });
      res.setHeader(
        "Set-Cookie",
        cookieHeader(CONSENT_COOKIE, browserKey, {
          path: "/id",
          maxAge: CONSENT_TTL_MS / 1000,
          secure: secureCookies,
        }),
      );
      res.setHeader("Cache-Control", "no-store");
      res.send(
        consentPage({
          consentId,
          clientName: client.name,
          selfDeclared: client.kind === "registered" && client.selfDeclared,
          clientId: client.clientId,
          legacy: client.kind === "legacy",
          callbackHost: callbackHost(hidden.redirect_uri),
          callback: hidden.redirect_uri,
          library: await libraryLabel(hidden.resource),
          username: user.username,
        }),
      );
    });

    // Allow or Deny. The consent id is single-use and must arrive with the
    // cookie set on the page that showed it (double submit), so another site
    // cannot answer for the person.
    app.post("/id/consent", async (req, res) => {
      const consentId = form(req, "consent_id");
      const pending = consentId ? consents.get(consentId) : undefined;
      if (consentId) consents.delete(consentId);
      const browserKey = readCookie(req.headers, CONSENT_COOKIE, { path: "/id", secure: secureCookies }) ?? "";
      res.setHeader(
        "Set-Cookie",
        cookieHeader(CONSENT_COOKIE, "", { path: "/id", clear: true, secure: secureCookies }),
      );
      if (!pending || pending.expiresAt < Date.now() || !sameSecret(browserKey, pending.browserKey)) {
        res.status(400).send("This sign-in expired. Start again from the app.");
        return;
      }
      const client = await resolveClient(pending.clientId);
      if (!client || !redirectAllowed(client, pending.redirectUri)) {
        res.status(400).send("invalid redirect_uri");
        return;
      }
      const { state, browserKey: _key, expiresAt: _expires, ...grant } = pending;
      if (form(req, "decision") !== "allow") {
        const next = new URL(pending.redirectUri);
        next.searchParams.set("error", "access_denied");
        next.searchParams.set("error_description", "The person denied access.");
        if (state) next.searchParams.set("state", state);
        res.redirect(next.toString());
        return;
      }
      const current = await accounts.findById(grant.sub);
      if (!current || current.disabled) {
        res.status(400).send("This account is disabled.");
        return;
      }
      redirectWithCode(res, grant, state);
    });

    app.post("/id/token", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const grant = form(req, "grant_type");
      if (grant === "refresh_token") {
        await sendRefresh(req, res);
        return;
      }
      if (grant !== "authorization_code") {
        res.status(400).json({ error: "unsupported_grant_type" });
        return;
      }
      const code = form(req, "code");
      const record = code ? codes.get(code) : undefined;
      if (code) codes.delete(code);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (!form(req, "client_id") || form(req, "client_id") !== record.clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }
      if (form(req, "redirect_uri") !== record.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      const client = await resolveClient(record.clientId);
      if (!client || !redirectAllowed(client, record.redirectUri)) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      const verifier = form(req, "code_verifier");
      const challenge = await pkceChallenge(verifier);
      if (!verifier || challenge !== record.challenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "pkce verification failed" });
        return;
      }
      const accessToken = await issueAccessToken({
        sub: record.sub,
        realmRole: record.realmRole,
        clientId: record.clientId,
        resource: record.resource,
      });
      const idToken = await issueIdToken({
        sub: record.sub,
        clientId: record.clientId,
        nonce: record.nonce,
      });
      const refreshToken = await issueRefreshToken({
        sub: record.sub,
        clientId: record.clientId,
        resource: record.resource,
      });
      res.json({
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: refreshToken,
        scope: scopeFor(record.realmRole),
      });
    });

    async function sendRefresh(req: Request, res: Response): Promise<void> {
      const token = form(req, "refresh_token");
      const now = Date.now();
      const claim = token ? await store.claimRefresh(hashRefreshToken(token), now) : { status: "missing" as const };
      if (claim.status === "reused") {
        // A rotated token came back: either the client or a thief holds a copy.
        // The store already dropped the whole chain; both must sign in again.
        console.log(`Refresh token reuse for client ${claim.record.clientId}; revoked that sign-in.`);
        res.status(400).json({ error: "invalid_grant", error_description: "refresh token reuse" });
        return;
      }
      if (claim.status === "missing") {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const record = claim.record;
      const refuse = async () => {
        await store.revokeChain(record.chainId);
        res.status(400).json({ error: "invalid_grant" });
      };
      if (
        form(req, "client_id") !== record.clientId ||
        record.expiresAt <= now ||
        record.chainStartedAt + refreshMaxMs <= now
      ) {
        await refuse();
        return;
      }
      const client = await resolveClient(record.clientId);
      if (!client) {
        await refuse();
        return;
      }
      // The refresh chain renews itself, so it must stop when the account does.
      // Look the account up again: a disabled account gets nothing, and the role
      // is the account's role now, not the one it had at sign-in.
      const current = await accounts.findById(record.sub);
      if (!current || current.disabled || (current.sessionsRevokedAt ?? 0) > record.chainStartedAt) {
        await refuse();
        return;
      }
      const realmRole = realmRoleFor(current.role);
      const accessToken = await issueAccessToken({
        sub: record.sub,
        realmRole,
        clientId: record.clientId,
        resource: record.resource,
      });
      const refreshToken = await issueRefreshToken({
        sub: record.sub,
        clientId: record.clientId,
        resource: record.resource,
        chain: { chainId: record.chainId, chainStartedAt: record.chainStartedAt },
      });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: refreshToken,
        scope: scopeFor(realmRole),
      });
    }

    app.get("/id/logout", (_req, res) => {
      res.redirect(config.publicBaseUrl);
    });
  }

  async function revokeAccount(sub: string): Promise<void> {
    await store.revokeSubject(sub);
    await accounts.revokeSessions(sub);
  }

  return { endpoints, publicKey, kid, mount, revokeAccount };
}
