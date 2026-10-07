/**
 * Identity provider that runs inside the app.
 * Accounts are loaded from the store. There is no shared demo password.
 */
import express, { type Express, type Request, type Response } from "express";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AppConfig } from "../config.ts";
import type { AuthServerEndpoints } from "../http/discovery.ts";
import { pkceChallenge } from "../http/pkce.ts";
import type { AccountStore } from "./accounts.ts";
import { hashPassword, normalizeUsername, verifyPassword } from "./passwords.ts";
import { SIGN_IN_WAIT, SignInLimit } from "./signin-limit.ts";
import { isAllowedCallback } from "./redirect.ts";
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

type RefreshGrant = {
  sub: string;
  realmRole: string;
  clientId: string;
  resource: string;
  expiresAt: number;
};

const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;

function scopeFor(realmRole: string): string {
  return realmRole === "mpos-editor" ? "openid mpos:edit mpos:sa" : "openid mpos:readonly";
}

export type EmbeddedIdp = {
  endpoints: AuthServerEndpoints;
  publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
  mount: (app: Express) => void;
};

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

function redirectAllowed(uri: string, clientId: string, config: AppConfig): boolean {
  return isAllowedCallback(uri, {
    clientId,
    webClientId: config.webClientId,
    publicBaseUrl: config.publicBaseUrl,
  });
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
  username?: string;
}): string {
  const fields = Object.entries(input.hidden)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const title = input.setup ? "Create account" : "Sign in";
  const lead = input.setup
    ? "This is the first account. It is SA — it can manage people and every library. Choose a username and a password of at least 12 characters."
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · MCPEncode</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@450;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <main class="sign-in">
    <section class="panel">
      <h1>${title}</h1>
      ${lead ? `<p class="hint">${lead}</p>` : ""}
      ${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ""}
      <form method="post" action="/id/authorize">
        ${fields}
        ${input.setup ? `<input type="hidden" name="setup" value="1">` : ""}
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

/**
 * In-process OAuth 2.1 authorization server for local POC when Zitadel
 * is not running. Issues audience-bound JWTs with the same role claims the
 * resource server already understands.
 */
function realmRoleFor(role: Role): string {
  // Keep the Zitadel-era claim name so existing verifiers still resolve SA.
  return role === "sa" ? "mpos-editor" : "mpos-readonly";
}

export async function createEmbeddedIdp(
  config: AppConfig,
  accounts: AccountStore,
  options?: { signInLimit?: SignInLimit },
): Promise<EmbeddedIdp> {
  // Used when the username is unknown so a miss still spends a scrypt verification.
  const dummyPasswordHash = await hashPassword(`unused-${crypto.randomUUID()}`);
  const signInLimit = options?.signInLimit ?? new SignInLimit();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = "mpos-dev";
  jwk.use = "sig";
  jwk.alg = "RS256";

  const issuer = config.authIssuer;
  const codes = new Map<string, AuthCode>();
  // Access tokens last 15 minutes. A refresh token lets the kiosk stay signed
  // in across that expiry without sending the person through the browser again.
  // These live in memory: a publisher restart signs everyone out, which is
  // acceptable for this development identity provider.
  const refreshGrants = new Map<string, RefreshGrant>();

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

  function issueRefreshToken(input: Omit<RefreshGrant, "expiresAt">): string {
    const now = Date.now();
    for (const [key, grant] of refreshGrants) {
      if (grant.expiresAt < now) refreshGrants.delete(key);
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    refreshGrants.set(token, { ...input, expiresAt: now + REFRESH_TTL_MS });
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
      .setProtectedHeader({ alg: "RS256", kid: "mpos-dev" })
      .setIssuer(issuer)
      .setAudience(input.resource || config.authAudience)
      .setIssuedAt()
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
      .setProtectedHeader({ alg: "RS256", kid: "mpos-dev" })
      .setIssuer(issuer)
      .setAudience(input.clientId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  }

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

    app.post("/id/register", express.json({ limit: "16kb" }), (req, res) => {
      const requested = (req.body as { redirect_uris?: unknown } | undefined)?.redirect_uris;
      const redirectUris = Array.isArray(requested) ? requested : [];
      const accepted: string[] = [];
      for (const entry of redirectUris) {
        if (typeof entry !== "string" || !redirectAllowed(entry, "mpos-mcp", config)) {
          res.status(400).json({ error: "invalid_redirect_uri" });
          return;
        }
        accepted.push(entry);
      }
      res.status(201).json({
        client_id: "mpos-mcp",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: accepted,
      });
    });

    const showAuthorize = async (req: Request, res: Response, error?: string, username?: string) => {
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
        return;
      }
      if (!redirectAllowed(hidden.redirect_uri, hidden.client_id, config)) {
        res.status(400).send("invalid redirect_uri");
        return;
      }
      if (hidden.code_challenge_method !== "S256" || !hidden.code_challenge) {
        res.status(400).send("PKCE S256 is required");
        return;
      }
      const setup = (await accounts.count()) === 0;
      res.send(loginPage({ error, hidden, setup, username }));
    };

    app.get("/id/authorize", (req, res) => {
      void showAuthorize(req, res);
    });

    app.post("/id/authorize", async (req, res) => {
      const username = form(req, "username");
      const password = form(req, "password");
      const settingUp = form(req, "setup") === "1";
      const attemptKey = normalizeUsername(username) || "(blank)";
      const address = clientAddress(req);
      if (signInLimit.blocked(attemptKey, address)) {
        await showAuthorize(req, res, SIGN_IN_WAIT, username);
        return;
      }
      let user: { sub: string; role: Role; realmRole: string } | undefined;
      if (settingUp) {
        if (password !== form(req, "password_confirm")) {
          signInLimit.recordFailure(attemptKey, address);
          await showAuthorize(req, res, "Those passwords do not match.", username);
          return;
        }
        const created = await accounts.createFirst({ username, password });
        if (!created.ok) {
          signInLimit.recordFailure(attemptKey, address);
          await showAuthorize(req, res, created.message, username);
          return;
        }
        user = { sub: created.account.id, role: created.account.role, realmRole: realmRoleFor(created.account.role) };
      } else {
        const account = await accounts.findByUsername(username);
        const hash = account?.passwordHash ?? dummyPasswordHash;
        const match = await verifyPassword(password, hash);
        if (!account || !match) {
          signInLimit.recordFailure(attemptKey, address);
          await showAuthorize(req, res, "Unknown username or password.", username);
          return;
        }
        if (account.disabled) {
          signInLimit.recordFailure(attemptKey, address);
          await showAuthorize(req, res, "This account is disabled.", username);
          return;
        }
        user = { sub: account.id, role: account.role, realmRole: realmRoleFor(account.role) };
      }
      signInLimit.recordSuccess(attemptKey, address);
      const redirectUri = form(req, "redirect_uri");
      const clientId = form(req, "client_id");
      if (!clientId) {
        res.status(400).send("client_id is required");
        return;
      }
      if (!redirectAllowed(redirectUri, clientId, config)) {
        res.status(400).send("invalid redirect_uri");
        return;
      }
      const code = crypto.randomUUID();
      codes.set(code, {
        sub: user.sub,
        role: user.role,
        realmRole: user.realmRole,
        clientId,
        redirectUri,
        challenge: form(req, "code_challenge"),
        resource: form(req, "resource") || config.authAudience,
        nonce: form(req, "nonce"),
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      const next = new URL(redirectUri);
      next.searchParams.set("code", code);
      const state = form(req, "state");
      if (state) next.searchParams.set("state", state);
      res.redirect(next.toString());
    });

    app.post("/id/token", async (req, res) => {
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
      const record = codes.get(code);
      codes.delete(code);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (form(req, "redirect_uri") !== record.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      const verifier = form(req, "code_verifier");
      const challenge = await pkceChallenge(verifier);
      if (challenge !== record.challenge) {
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
      const refreshToken = issueRefreshToken({
        sub: record.sub,
        realmRole: record.realmRole,
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
      const record = token ? refreshGrants.get(token) : undefined;
      if (!record || record.expiresAt < Date.now() || form(req, "client_id") !== record.clientId) {
        if (token) refreshGrants.delete(token);
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      refreshGrants.delete(token);
      const accessToken = await issueAccessToken({
        sub: record.sub,
        realmRole: record.realmRole,
        clientId: record.clientId,
        resource: record.resource,
      });
      const refreshToken = issueRefreshToken({
        sub: record.sub,
        realmRole: record.realmRole,
        clientId: record.clientId,
        resource: record.resource,
      });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: refreshToken,
        scope: scopeFor(record.realmRole),
      });
    }

    app.get("/id/logout", (_req, res) => {
      res.redirect(config.publicBaseUrl);
    });
  }

  return { endpoints, publicKey, mount };
}
