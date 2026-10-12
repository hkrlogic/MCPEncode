# Develop / run notes

Deeper operator notes for MCPEncode. Product words and the status gate live in [AGENTS.md](../AGENTS.md).

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

Open `http://127.0.0.1:3000/` and sign in. The first visit creates the account (username, password of at least 12 characters). Postgres listens on `127.0.0.1:5432`. Connection settings are in `.env` (see `.env.example`).

For a deploy (Docker image, environment variables, `/healthz`, TLS), see [deploy.md](deploy.md).

An SA can open **Accounts** to create more people. Grant Access on a library by username (built-in sign-in) or IdP `sub` (OIDC). There are no shared demo passwords.

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

Tests need a running Postgres. Each test creates a throwaway `mpos_test_…` database and drops it afterwards, so the role that connects needs `CREATEDB`. The Compose `mpos` user is the database superuser, so it already can. With your own Postgres, either grant it (`ALTER ROLE mpos CREATEDB;`) or set `POSTGRES_ADMIN_USER` and `POSTGRES_ADMIN_PASSWORD` to a role that can create databases; tests use that role only to create and drop the throwaway databases, which stay owned by `POSTGRES_USER`. The app itself never needs `CREATEDB`.

## MCP tools (Lookups)

Each connection is one library.

| Tool | Permission | Returns |
| --- | --- | --- |
| `whoami` | any library role | sub, library, role, permissions |
| `list_items` | `records.read` | Pass `q` to answer. One clear match returns the full item. Several matches return summaries. Omit `q` to browse. |
| `open_item` | `records.read` | full item for one id |
| `search_shelf` | `records.read` | published item summaries across the library's shelf (only when the library is on a shelf) |
| `create_library` | `records.write` | name, schema starter, write_mode; optional table proposal |
| `propose_table` | `records.write` | table design for an empty library; human Approves |
| `propose_field` | `records.write` | one optional field to append; human Approves (cap 12) |
| `create_item` / `update_item` | `records.write` | Review Lock → draft; Review Unlock → published. General libraries take no `summary`: it is built from the body (text before the first table). Other libraries take a required one-line `summary`. |
| `delete_item` | `records.delete` | by id |
| `list_audit` | `audit.read` (publishers and SA) | who invoked which tool in this library |

No publish, approve, write-mode, or revert tools. Those stay in the publisher UI.

## Security notes

- Embedded mode is a development IdP in-process (OAuth 2.1 + PKCE). Do not expose it on a public network without understanding the tradeoffs.
- Access tokens must pass signature, issuer, expiry, and audience.
- Library access is an allow-list of subjects with reader or publisher role.
- A **Reader key** is optional, one per library, and Reader only. Publishers create it under Reader key; the plaintext is shown once and Postgres stores a SHA-256 hash. It lists and opens published items. It cannot write, publish, or read the audit log, and it cannot sign in to the publisher. Rotating Connect does not change it. In LibreChat, put the Connect link on the server, send `Authorization: Bearer <key>`, and set `requiresOAuth: false`.
- **One link, one library.** Every MCP item tool (`open_item`, `update_item`, `delete_item`, lookups) matches the item id *and* the link's library, for publishers and SA alike. An id from another library is "not found". `list_audit` shows only the link's library and is not offered to readers or Reader keys.
- **Disable and demotion take effect at once.** With built-in sign-in, every session, MCP request and token refresh looks the account up again. A disabled account gets nothing from an existing session, access token or refresh token. A demoted SA is no longer SA even if its token says so: the MCP tool list (write, delete, audit, shelf scope) is built only from the re-checked role. With `AUTH_MODE=oidc` the identity provider owns this.
- **Sign-out and password reset sign the account out everywhere.** Every refresh chain is deleted, and every session cookie and access token issued earlier is refused. MCP clients then sign in again.
- **Refresh tokens rotate.** They are stored as SHA-256 hashes in `oauth_refresh_tokens`. A rotated token presented again revokes that whole sign-in (reuse detection). A token unused for 12 hours expires, and a sign-in ends `OAUTH_REFRESH_MAX_DAYS` (default 30) after it started.
- **The signing key is kept in Postgres** (`oauth_signing_keys`), encrypted with a key derived from `SESSION_SECRET`, with a thumbprint `kid`. A restart keeps tokens valid. Changing `SESSION_SECRET` makes a new key, so everyone signs in again.
- **First account on a public address needs a setup code.** If `PUBLIC_BASE_URL` or `BIND_HOST` is not loopback, the create-account page asks for `SETUP_TOKEN` (or a random code printed once to the server log). Wrong codes count toward the sign-in wait. Local-only instances need no code.
- **MCP clients register, and get a consent page.** `/id/register` stores a random client id with its callbacks (`oauth_clients`). Authorize and token require one of those callbacks exactly (a loopback IP callback may change port, RFC 8252 §7.3), and the token endpoint checks `client_id`. By default only loopback and app-scheme callbacks register; a remote https host must be in `OAUTH_REDIRECT_HOSTS` (or `OAUTH_ALLOW_ANY_HTTPS_REDIRECT=true`). After the password, the consent page names the client, the callback host and the library; Allow/Deny posts back with a single-use id bound to a cookie. The publisher's own sign-in skips it. The old shared id `mpos-mcp` still works for loopback and app-scheme callbacks while `OAUTH_LEGACY_CLIENT` is on. Tokens can only be requested for this app's login or one of its library links.
- The access token is never written to Postgres — only `sub` as actor fields.
- Tool results label store content as **data**, not instructions.
- Markdown preview does not execute raw HTML in item bodies.
- UI session is an httpOnly cookie; forms carry CSRF.
- Default bind is `127.0.0.1`. Queries are parameterized. Remote Postgres requires `POSTGRES_SSL=required`.

## Layout

- `src/auth/` — JWKS verifier, roles, UI session, embedded IdP
- `src/db/` — Postgres, migrations, domain queries; `queries.ts` is the barrel
- `src/http/` — Express app, routes, pages
- `src/items/` — Zod schemas and Policy / Procedure templates
- `src/markdown/` — sanitize, preview, table ↔ Markdown
- `src/mcp/` — tools
- `migrations/` — applied on startup
- `public/` — browser editor and styles
- `AGENTS.md` — product vocabulary for agents

## Later

Optimistic concurrency, soft-delete, first-class sections (Table, Checklist, Details, Description), MFA, export whole library, SA breakglass.
