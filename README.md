# MCPEncode (Publisher)

This is the **publisher** surface (**MCPEncode**). It lives in `~/MCPEncode` and is separate from the kiosk workspace (`~/organization-chat`). GitHub: [hkrlogic/MCPEncode](https://github.com/hkrlogic/MCPEncode).

A **POC** of a Model Context Protocol (MCP) server with real OAuth 2.1 login, two roles, libraries of items in MariaDB, and a localhost Markdown UI. MCP is the connector; the product words are library, item, and section.

OAuth 2.1 proves who you are. **MCPEncode** only checks the access token, maps the role to permissions, then lets Cursor and the browser use the same libraries.

By default the POC runs a **development identity provider** in the same process (no Docker). That still uses authorization-code + PKCE and audience-bound JWTs. Point `AUTH_MODE=oidc` at Keycloak when Docker Desktop is running if you want an external issuer.

## What you get

| Piece | Role |
| --- | --- |
| Identity | OAuth 2.1 authorization code + PKCE. MCPEncode never stores passwords. |
| Roles | **read-only** and **edit**. Edit includes delete. |
| Permissions | Tools and the UI check `records.read` / `records.write` / `records.delete` / `audit.read`, not the role name. |
| MariaDB | Libraries and items live in database `mpos`. Each item belongs to a library and has a required summary and a status (`draft` or `published`). Reads and writes use `items`. The older `records` table is **frozen** (kept, not dropped; no new writes). |
| Cursor | Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`. |
| Browser | `http://127.0.0.1:3000/` — Jspreadsheet CE grid (first row = titles) saved as Markdown tables. |

Read-only callers never see write tools in Cursor, and the add/edit forms are omitted in the UI.

## Prerequisites

- Node.js 22+
- Docker Desktop (MariaDB). Also used if you switch `AUTH_MODE=oidc` for Keycloak.

## Run

```bash
cd ~/MCPEncode
docker compose up -d mariadb
npm install
npm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and sign in. MariaDB listens on `127.0.0.1:3306` only. Connection settings are in `.env` (see `.env.example`).

Demo users (change these before this is more than a laptop demo):

| Username | Password | Role |
| --- | --- | --- |
| `editor` | `editor-pass` | edit |
| `reader` | `reader-pass` | read-only |

### Cursor

`.cursor/mcp.json` points at `http://127.0.0.1:3000/mcp` with client id `mpos-mcp`. In **Settings → Tools & MCP**, connect **MCPEncode** (or the local server named in that config). Cursor will 401, discover the IdP, and open a browser login.

Use `http://127.0.0.1:3000/mcp` consistently. `localhost` is a different token audience and login will fail.

Cursor’s desktop OAuth return URL is `http://localhost:8787/callback`. Leave that port free while connecting (the kiosk does not use 8787; it returns to its own `/oauth/callback`).

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
| `list_libraries` | `records.read` | id, name, template for each library |
| `list_records` | `records.read` | One library plus a question (`library_name` or `library_id`, and `q`). One clear match returns the full item. Several matches return short summaries. |
| `get_record` | `records.read` | full Markdown for one id |
| `create_library` | `records.write` | name, template (`general`, `policy`, or `procedure`) |
| `create_record` / `update_record` | `records.write` | name, body / template fields, labels |
| `delete_record` | `records.delete` | by id only |
| `list_audit` | `audit.read` | who invoked which tool |

There is no `run_sql` tool. Queries are parameterized in code.

## Security notes (why it is built this way)

- In **oidc** mode MCPEncode is only a resource server and does not issue tokens. The default **embedded** mode runs a development IdP in-process (OAuth 2.1 + PKCE). Do not expose that to a network.
- Access tokens must pass signature, issuer, expiry, and **audience** = `MCP_RESOURCE_URL`.
- The access token is never written to MariaDB. Only the user id (`sub`) is stored as `created_by` / `updated_by`.
- Tool results label store content as **data**, not instructions (indirect prompt injection).
- The Markdown preview **does not execute raw HTML** in notes.
- Pasted Word/Docs HTML is converted to Markdown before save.
- The UI session is an httpOnly cookie. Forms carry a CSRF token.
- The HTTP server binds to `127.0.0.1` by default. MariaDB is published on `127.0.0.1:3306`. The app connects as user `mpos`, not root. Queries stay parameterized. `LOAD DATA LOCAL` is off.

## Tests

```bash
npm test
```

Verifier tests mint local JWTs and do not need Docker. Tests that touch libraries or items need MariaDB (`docker compose up -d mariadb`).

## Layout

- `src/auth/` — JWKS verifier, role → permission map, UI session
- `migrations/` — SQL applied once on startup. Adds `items` and `publish_audit`. Does not drop `records`.
- `src/db/` — MariaDB connection, migrations, and queries
- `src/mcp/` — tools
- `src/http/` — HTML UI and OAuth callback
- `keycloak/` — realm import (two users, two clients, audience mapper)

## Product freeze

See `../AGENTS.md`. Short version: `items` is source of truth (`name`, `labels`, `summary`, `body`, `status`); do not write to `records`; keep live MCP tool names until a planned rename; sections become first-class later — do not invent a third body shape now.

## Later (not this POC)

TLS on a public bind, TLS to MariaDB when it is not on this machine, a third admin role, optimistic concurrency, soft-delete, drop frozen `records`, first-class sections.
