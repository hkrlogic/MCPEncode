import type { Express, Request, Response } from "express";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AppConfig } from "../config.ts";
import type { Role } from "./rbac.ts";
import type { AuthServerEndpoints } from "../http/discovery.ts";
import { pkceChallenge } from "../http/pkce.ts";

type DemoUser = { username: string; password: string; sub: string; role: Role; realmRole: string };

const USERS: DemoUser[] = [
  {
    username: "editor",
    password: "editor-pass",
    sub: "mpos-editor",
    role: "edit",
    realmRole: "mpos-editor",
  },
  {
    username: "reader",
    password: "reader-pass",
    sub: "mpos-reader",
    role: "readonly",
    realmRole: "mpos-readonly",
  },
];

const ALLOWED_REDIRECTS = [
  // Publisher web UI
  "http://127.0.0.1:3000/callback",
  // Cursor desktop MCP OAuth (fixed loopback — do not reuse this port for other apps)
  "http://localhost:8787/callback",
  "http://127.0.0.1:8787/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  // Kiosk: OAuth returns to the kiosk origin (same pattern as production https://…/oauth/callback)
  "http://127.0.0.1:8765/oauth/callback",
  "http://localhost:8765/oauth/callback",
];

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
  return realmRole === "mpos-editor" ? "openid mpos:edit" : "openid mpos:readonly";
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

function form(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function redirectAllowed(uri: string, publicBaseUrl: string): boolean {
  // The deployed site returns to its own /callback. Local and Cursor
  // addresses stay on the fixed list above.
  if (uri === `${publicBaseUrl}/callback`) return true;
  return ALLOWED_REDIRECTS.includes(uri);
}

function loginPage(input: { error?: string; hidden: Record<string, string> }): string {
  const fields = Object.entries(input.hidden)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${value.replaceAll('"', "&quot;")}">`)
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Mpos</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <main class="sign-in">
    <section class="panel">
      <h1>Sign in</h1>
      ${input.error ? `<p class="error" role="alert">${input.error}</p>` : ""}
      <form method="post" action="/id/authorize">
        ${fields}
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">Continue</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

/**
 * In-process OAuth 2.1 authorization server for local POC when Docker/Keycloak
 * is not available. Issues audience-bound JWTs with the same role claims the
 * resource server already understands.
 */
export async function createEmbeddedIdp(config: AppConfig): Promise<EmbeddedIdp> {
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
      scopes_supported: ["openid", "mpos:readonly", "mpos:edit"],
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

    app.post("/id/register", (req, res) => {
      const requested = (req.body as { redirect_uris?: string[] } | undefined)?.redirect_uris ?? [];
      res.status(201).json({
        client_id: "mpos-mcp",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: requested.length ? requested : ALLOWED_REDIRECTS,
      });
    });

    const showAuthorize = (req: Request, res: Response, error?: string) => {
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
      if (!redirectAllowed(hidden.redirect_uri, config.publicBaseUrl)) {
        res.status(400).send("invalid redirect_uri");
        return;
      }
      if (hidden.code_challenge_method !== "S256" || !hidden.code_challenge) {
        res.status(400).send("PKCE S256 is required");
        return;
      }
      res.send(loginPage({ error, hidden }));
    };

    app.get("/id/authorize", (req, res) => {
      showAuthorize(req, res);
    });

    app.post("/id/authorize", async (req, res) => {
      const username = form(req, "username");
      const password = form(req, "password");
      const user = USERS.find((entry) => entry.username === username && entry.password === password);
      if (!user) {
        showAuthorize(req, res, "Unknown username or password.");
        return;
      }
      const redirectUri = form(req, "redirect_uri");
      if (!redirectAllowed(redirectUri, config.publicBaseUrl)) {
        res.status(400).send("invalid redirect_uri");
        return;
      }
      const code = crypto.randomUUID();
      codes.set(code, {
        sub: user.sub,
        role: user.role,
        realmRole: user.realmRole,
        clientId: form(req, "client_id") || "mpos-web",
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
