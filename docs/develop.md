# Develop / run notes

Running MCPEncode from source, tests, and security notes. The short agent guide is [AGENTS.md](../AGENTS.md); words, roles, tools and architecture are in [concepts.md](concepts.md).

## Prerequisites

- Node.js 22+
- PostgreSQL 16 (the documented version, used by Compose and CI; also verified on 17). Docker Compose is the easy way to get it.

## Run

```bash
scripts/init-env.sh   # first run only: creates .env with random secrets
docker compose up -d postgres
npm install
npm start
```

Open `http://127.0.0.1:3000/` and sign in. Create the first account: enter the setup code (`SETUP_TOKEN` in `.env`; `scripts/init-env.sh` wrote one), a username and a password of at least 12 characters. Postgres listens on `127.0.0.1:5432`. Connection settings are in `.env` (see `.env.example`).

For a deploy (Docker image, environment variables, `/healthz`, TLS), see [deploy.md](deploy.md).

A Site admin can open **Accounts** to create more people. Grant Access on a library by username (built-in sign-in) or IdP `sub` (OIDC). There are no shared demo passwords.

### Cursor

Copy `.cursor/mcp.example.json` to `.cursor/mcp.json` (git-ignored), then open a library → **Connect** → put that URL in it. With built-in sign-in, Cursor registers itself and gets its own client id. In **Settings → Tools & MCP**, connect the library. Cursor will 401, discover the issuer, register, and open a browser login. After the password, **Allow** on the consent page.

Use `127.0.0.1` consistently. `localhost` is a different host. The token audience is that library URL.

Cursor’s desktop OAuth return URL is `http://localhost:8787/callback`. Leave that port free while connecting.

## Tests and lint

```bash
npm run typecheck
npm run lint      # Biome
npm test
```

Tests need a running Postgres. Each test creates a throwaway `mcpencode_test_…` database and drops it afterwards, so the role that connects needs `CREATEDB`. The Compose database user is the database superuser, so it already can. With your own Postgres, either grant it (`ALTER ROLE <user> CREATEDB;`) or set `POSTGRES_ADMIN_USER` and `POSTGRES_ADMIN_PASSWORD` to a role that can create databases; tests use that role only to create and drop the throwaway databases, which stay owned by `POSTGRES_USER`. The app itself never needs `CREATEDB`.

## MCP tools

The tool list and who may call each tool: [concepts.md](concepts.md#mcp-tools).

## Security notes

- Embedded mode is a development IdP in-process (OAuth 2.1 + PKCE). Do not expose it on a public network without understanding the tradeoffs.
- Access tokens must pass signature, issuer, expiry, and audience.
- Library access is an allow-list of subjects with reader or publisher role.
- A **Reader key** is optional, one per library, and Reader only. Publishers create it under Reader key; the plaintext is shown once and Postgres stores a SHA-256 hash. It lists and opens published items. It cannot write, publish, or read the audit log, and it cannot sign in to the publisher. Rotating Connect does not change it. In LibreChat, put the Connect link on the server, send `Authorization: Bearer <key>`, and set `requiresOAuth: false`.
- **One link, one library.** Every MCP item tool (`open_item`, `update_item`, `delete_item`, lookups) matches the item id *and* the link's library, for publishers and SA alike. An id from another library is "not found". `list_audit` shows only the link's library and is not offered to readers or Reader keys.
- **Disable and demotion take effect at once.** With built-in sign-in, every session, MCP request and token refresh looks the account up again. A disabled account gets nothing from an existing session, access token or refresh token. A demoted SA is no longer SA even if its token says so: the MCP tool list (write, delete, audit, shelf scope) is built only from the re-checked role. With `AUTH_MODE=oidc` the identity provider owns this.
- **Sign-out and password reset sign the account out everywhere.** Every refresh chain is deleted, and every session cookie and access token issued earlier is refused. MCP clients then sign in again.
- **Refresh tokens rotate.** They are stored as SHA-256 hashes in `oauth_refresh_tokens`. A rotated token presented again revokes that whole sign-in (reuse detection). A token unused for 12 hours expires, and a sign-in ends 30 days after it started.
- **The signing key is kept in Postgres** (`oauth_signing_keys`), encrypted with a key derived from `SESSION_SECRET`, with a thumbprint `kid`. A restart keeps tokens valid. Changing `SESSION_SECRET` makes a new key, so everyone signs in again.
- **The first account always needs a setup code.** The create-account page asks for `SETUP_TOKEN` (or a random code printed once to the server log), on every address: a reverse proxy on the same host makes every visitor look like loopback, so the address is no reason to skip it. There is no setting to turn it off. Wrong codes count toward the sign-in wait.
- **Sign-in throttling.** An attempt is counted before its password is hashed, and at most 2 scrypt hashes run at once (64 MiB each); past a queue of 64 the form answers "busy" at once. Misses back off exponentially (1 s, doubling, up to 15 minutes) per username from one address after 5, per address after 20, and per username across all addresses after 100. Nothing is ever hard-locked: someone guessing at the SA only slows down their own address, and a successful sign-in clears that username. Counts are per process; the client address is the socket peer unless `TRUST_PROXY` says which proxies to believe.
- **Strict Content-Security-Policy.** `script-src 'self'`: no inline script or inline handlers. Page behaviour (confirm prompts via `data-confirm`, copy buttons, menus, sign-out) lives in `public/page.js`. A test fails if page markup gains an inline `<script>` or `on…=` attribute.
- **Connect token.** The library MCP link carries the token in its path. Clients that can set headers can connect to `/libraries/<id>/mcp` and send it in `X-Library-Token` instead, which keeps it out of URLs and access logs. Tokens are stored in plain text, so the publisher can show the link again; migration 015 replaced the weak md5 tokens migration 007 gave older libraries.
- **Sign-out is a POST** with the CSRF token (`GET /logout` shows a confirm form). CSRF tokens are compared in constant time; an upload's token must arrive before the file (header or the first form field), so a forged upload is never buffered. On HTTPS the session cookie is `__Host-mcpencode_session` (path-scoped cookies get `__Secure-`).
- **MCP clients register, and get a consent page.** `/id/register` stores a random client id with its callbacks (`oauth_clients`). Authorize and token require one of those callbacks exactly (a loopback IP callback may change port, RFC 8252 §7.3), and the token endpoint checks `client_id`. By default only loopback and app-scheme callbacks register; a remote https host must be in `OAUTH_REDIRECT_HOSTS`. After the password, the consent page names the client, the callback host and the library; Allow/Deny posts back with a single-use id bound to a cookie. The publisher's own sign-in skips it. Tokens can only be requested for this app's login or one of its library links.
- The access token is never written to Postgres — only `sub` as actor fields.
- Tool results label store content as **data**, not instructions.
- Markdown preview does not execute raw HTML in item bodies.
- UI session is an httpOnly cookie (`__Host-` prefixed on HTTPS); forms carry CSRF.
- Default bind is `127.0.0.1`. Queries are parameterized. Remote Postgres requires `POSTGRES_SSL=required`.

## Layout

See the repo map in [AGENTS.md](../AGENTS.md#repo-map) and the architecture in [concepts.md](concepts.md#architecture).

## Later

Optimistic concurrency, soft-delete, first-class sections (Table, Checklist, Details, Description), MFA, export whole library, Site admin break-glass.
