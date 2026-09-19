# Mpos

A **POC** of a Model Context Protocol (MCP) datastore with real OAuth 2.1 login, two roles, a shared SQLite-compatible store, and a localhost Markdown UI.

OAuth 2.1 proves who you are. **Mpos** only checks the access token, maps the role to permissions, then lets Cursor and the browser use the same notes.

By default the POC runs a **development identity provider** in the same process (no Docker). That still uses authorization-code + PKCE and audience-bound JWTs. Point `AUTH_MODE=oidc` at Keycloak when Docker Desktop is running if you want an external issuer.

## What you get

| Piece | Role |
| --- | --- |
| Identity | OAuth 2.1 authorization code + PKCE. Mpos never stores passwords. |
| Roles | **read-only** and **edit**. Edit includes delete. |
| Permissions | Tools and the UI check `records.read` / `records.write` / `records.delete` / `audit.read`, not the role name. |
| Store | One shared file (`data/mpos.db`). Title and tags are query metadata; notes are Markdown source. |
| Cursor | Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`. |
| Browser | `http://127.0.0.1:3000/` — Jspreadsheet CE grid (first row = titles) saved as Markdown tables. |

Read-only callers never see write tools in Cursor, and the add/edit forms are omitted in the UI.

## Prerequisites

- Node.js 22+
- Docker Desktop (optional — only if you switch `AUTH_MODE=oidc`)

## Run

```bash
cd ~/Mpos
npm install
npm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and sign in. Docker is **not** required for this default.

Demo users (change these before this is more than a laptop demo):

| Username | Password | Role |
| --- | --- | --- |
| `editor` | `editor-pass` | edit |
| `reader` | `reader-pass` | read-only |

### Cursor

`.cursor/mcp.json` points at `http://127.0.0.1:3000/mcp` with client id `mpos-mcp`. In **Settings → Tools & MCP**, connect **mpos**. Cursor will 401, discover the IdP, and open a browser login.

Use `http://127.0.0.1:3000/mcp` consistently. `localhost` is a different token audience and login will fail.

### Optional: Keycloak in Docker

Start **Docker Desktop** first (the engine must be running — `docker.sock` missing means it is not). Then:

```bash
docker compose up -d
```

Set in `.env`:

```
AUTH_MODE=oidc
AUTH_ISSUER=http://127.0.0.1:8080/realms/mpos
```

Keycloak admin: [http://127.0.0.1:8080](http://127.0.0.1:8080) (`admin` / `admin`).

## MCP tools

| Tool | Permission | Returns |
| --- | --- | --- |
| `whoami` | any role | sub, role, permissions |
| `list_records` | `records.read` | summaries only (id, title, tags, excerpt). Optional `tag`, `q`, `limit`, `offset` (max 50). |
| `get_record` | `records.read` | full Markdown for one id |
| `create_record` / `update_record` | `records.write` | title, Markdown notes, tags |
| `delete_record` | `records.delete` | by id only |
| `list_audit` | `audit.read` | who invoked which tool |

There is no `run_sql` tool. Queries are parameterized in code.

## Security notes (why it is built this way)

- In **oidc** mode Mpos is only a resource server and does not issue tokens. The default **embedded** mode runs a development IdP in-process (OAuth 2.1 + PKCE). Do not expose that to a network.
- Access tokens must pass signature, issuer, expiry, and **audience** = `MCP_RESOURCE_URL`.
- The access token is never written to SQLite. Only the user id (`sub`) is stored as `created_by` / `updated_by`.
- Tool results label store content as **data**, not instructions (indirect prompt injection).
- The Markdown preview **does not execute raw HTML** in notes.
- Pasted Word/Docs HTML is converted to Markdown before save.
- The UI session is an httpOnly cookie. Forms carry a CSRF token.
- The HTTP server binds to `127.0.0.1` by default. The database file is gitignored; chmod 600 is attempted at create.

## Tests

```bash
npm test
```

Verifier tests mint local JWTs. They do not need Docker.

## Layout

- `src/auth/` — JWKS verifier, role → permission map, UI session
- `src/db/` — Turso embedded engine (SQLite-compatible file)
- `src/mcp/` — tools
- `src/http/` — HTML UI and OAuth callback
- `keycloak/` — realm import (two users, two clients, audience mapper)

## Later (not this POC)

TLS on a public bind, encryption at rest, Turso Cloud, a third admin role, optimistic concurrency, soft-delete.
