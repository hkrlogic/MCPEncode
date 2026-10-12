# External sign-in (OIDC)

By default MCPEncode has its own accounts (built-in sign-in). With `AUTH_MODE=oidc` it trusts an external OpenID Connect issuer instead: people sign in there, and MCPEncode only checks the tokens. Zitadel is the tested issuer; any issuer that publishes OpenID discovery and puts a role in its access tokens can work.

Most installs do not need this. Leave `AUTH_MODE` unset unless you already run an identity provider.

## Settings

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `oidc` |
| `AUTH_ISSUER` | The issuer URL, e.g. `https://id.example.org`. MCPEncode reads `<issuer>/.well-known/openid-configuration` at startup. |
| `AUTH_AUDIENCE` | The audience web sign-in tokens carry. For Zitadel, the project id (it is also used to request the `…:aud` scope). |
| `AUTH_MCP_AUDIENCE` | **Required.** The audience library MCP tokens must carry, different from `AUTH_AUDIENCE`, so a token for the web app cannot open MCP and the other way round. Startup fails without it. |
| `WEB_CLIENT_ID` | The client id of the web app registered at the issuer. Default `mcpencode-web`. |
| `AUTH_JWKS_URL` | The issuer's key set. Default `<AUTH_ISSUER>/protocol/openid-connect/certs` (Keycloak layout). For Zitadel set `<AUTH_ISSUER>/oauth/v2/keys`. |

`SESSION_SECRET`, the database settings and `PUBLIC_BASE_URL` are still required ([deploy.md](deploy.md#environment)). `SETUP_TOKEN` is not used: there is no first-account page.

## At the issuer

1. Register a web application (public client, PKCE, authorization code) with redirect URI `<PUBLIC_BASE_URL>/callback` and post-logout URI `<PUBLIC_BASE_URL>` (no trailing slash). Its client id is `WEB_CLIENT_ID`.
2. Give each person a role. MCPEncode reads role names from the Zitadel project roles claim (`urn:zitadel:iam:org:project:roles`), a `roles` claim, `realm_access.roles`, or the token scope:
   - `mpos-editor` (or `mpos-sa`) → Site admin
   - `mpos-readonly` (or `mpos-reader`) → can sign in; library roles come from Access
   These role names are kept from earlier releases so existing issuer setups keep working.
3. Make MCP tokens carry `AUTH_MCP_AUDIENCE` (with Zitadel, a second project or an audience scope for the MCP client).

## Zitadel login scopes

For Zitadel the web sign-in requests `openid`, `urn:zitadel:iam:org:project:roles` and `urn:zitadel:iam:org:project:id:<AUTH_AUDIENCE>:aud`. Zitadel rejects scope names it does not know, so the built-in sign-in's own scopes are never sent to it. Zitadel does not implement resource indicators, so the `resource` parameter is not sent in oidc mode.

## Access and accounts

- Grant Access on a library by the issuer's `sub` for that person.
- Disabling a person, MFA and password rules are the issuer's job. The **Accounts** page and the first-account setup are built-in sign-in only.
- MCP clients connect with the library's Connect link and sign in at the issuer. Client registration and the consent page are the issuer's (built-in sign-in only has them).

## Checking it

```bash
curl -s https://library.example.org/.well-known/openid-configuration | head   # should name your issuer
curl -s https://library.example.org/healthz
```

A startup error `AUTH_MCP_AUDIENCE is required when AUTH_MODE=oidc` means step 3 / the setting is missing. `Could not load OAuth discovery` means `AUTH_ISSUER` is wrong or unreachable from the container.
