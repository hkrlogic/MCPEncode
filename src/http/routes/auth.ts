/** OAuth login, callback, and logout routes. */
import type express from "express";
import type { Role } from "../../auth/rbac.ts";
import { loginScopes } from "../../auth/scopes.ts";
import { signSession } from "../../auth/session.ts";
import { cookieHeader, readCookie } from "../cookies.ts";
import { OAUTH_COOKIE, SESSION_COOKIE, setCookies } from "../helpers.ts";
import { errorPage } from "../pages.ts";
import { newPkceVerifier, pkceChallenge, readHandshake, signHandshake } from "../pkce.ts";
import type { AppRouteContext } from "./context.ts";

export function registerAuthRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, authServer, verifier } = ctx;
  // Browsers only send these cookies over HTTPS when the public address is HTTPS.
  const secure = config.publicBaseUrl.startsWith("https://");

  app.get("/login", async (_req, res) => {
    const state = crypto.randomUUID();
    const verifierPkce = newPkceVerifier();
    const challenge = await pkceChallenge(verifierPkce);
    const handshake = await signHandshake({ state, verifier: verifierPkce }, config.sessionSecret);
    const authorize = new URL(authServer.authorizationEndpoint);
    authorize.searchParams.set("client_id", config.webClientId);
    authorize.searchParams.set("redirect_uri", `${config.publicBaseUrl}/callback`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", loginScopes(config).join(" "));
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    // Zitadel does not implement resource indicators and rejects the parameter
    // on some grants. The embedded IdP uses it as the token audience.
    if (config.authMode !== "oidc") {
      authorize.searchParams.set("resource", config.authAudience);
    }
    setCookies(res, [cookieHeader(OAUTH_COOKIE, handshake, { maxAge: 600, secure })]);
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
    });
    if (config.authMode !== "oidc") {
      body.set("resource", config.authAudience);
    }
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
        .send(errorPage("Signed in, but this account has no MCPEncode role (read-only or edit)."));
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
      cookieHeader(SESSION_COOKIE, session, { maxAge: 60 * 60, secure }),
      cookieHeader(OAUTH_COOKIE, "", { clear: true, secure }),
    ]);
    res.redirect("/");
  });

  app.get("/logout", (_req, res) => {
    setCookies(res, [cookieHeader(SESSION_COOKIE, "", { clear: true, secure })]);
    if (authServer.endSessionEndpoint) {
      const logout = new URL(authServer.endSessionEndpoint);
      logout.searchParams.set("client_id", config.webClientId);
      logout.searchParams.set("post_logout_redirect_uri", config.publicBaseUrl);
      res.redirect(logout.toString());
      return;
    }
    res.redirect("/");
  });
}
