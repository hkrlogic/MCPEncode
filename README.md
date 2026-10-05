# MCPEncode (Publisher)

This is the **publisher** surface (**MCPEncode**). It lives in `~/MCPEncode` and is separate from the kiosk workspace (`~/organization-chat`). GitHub: [hkrlogic/MCPEncode](https://github.com/hkrlogic/MCPEncode).

A **POC** of a Model Context Protocol (MCP) server with real OAuth 2.1 login, two roles, libraries of items in PostgreSQL, and a localhost Markdown UI. MCP is the connector; the product words are **library**, **item**, and **section**.

OAuth 2.1 proves who you are. **MCPEncode** only checks the access token, maps the role to permissions, then lets Cursor and the browser use the same libraries.

By default the POC runs a **development identity provider** in the same process (no Docker IdP). That still uses authorization-code + PKCE and audience-bound JWTs. Point `AUTH_MODE=oidc` at Keycloak when Docker Desktop is running if you want an external issuer.

## What you get

| Piece | Role |
| --- | --- |
| Identity | OAuth 2.1 authorization code + PKCE. MCPEncode never stores passwords. |
| Roles | IdP **read-only** / **edit** for sign-in and adding libraries. Per library: **reader** / **publisher** on the access list (by IdP `sub`). |
| Permissions | Tools and the UI check `records.read` / `records.write` / `records.delete` / `audit.read` from the library role. |
| PostgreSQL | Libraries and items live in database `mpos`. Each item has a name, labels (JSONB), a required summary, a body, and a status. Reads and writes use `items`. The older `records` table is **frozen** (kept, not dropped; no new writes). |
| Status gate | Items: **Pending** (`draft`) → **Published** → optional **Archived**. Edit always saves a draft (published items unpublish on edit). Publish / unpublish / archive are UI actions. Readers and reader MCP only see published. |
| Cursor | One MCP link per library: `http://127.0.0.1:3000/libraries/{id}/mcp` (copy from Open library). Global `/mcp` is retired. |
| Browser | `http://127.0.0.1:3000/` — signed-out landing, then libraries you can open. General libraries use a Jspreadsheet CE grid (first row = titles) saved as Markdown tables; Policy and Procedure libraries use fixed fields. |

Read-only callers never see write tools in Cursor, and the add/edit forms are omitted in the UI.

## Prerequisites

- Node.js 22+
- Docker Desktop (PostgreSQL). Also used if you switch `AUTH_MODE=oidc` for Keycloak.

## Run

```bash
cd ~/MCPEncode
docker compose up -d postgres
npm install
npm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and sign in. Postgres listens on `127.0.0.1:5432` only. Connection settings are in `.env` (see `.env.example`).

Demo users (change these before this is more than a laptop demo):

| Username | Password | Role |
| --- | --- | --- |
| `editor` | `editor-pass` | edit |
| `reader` | `reader-pass` | read-only |

### Cursor

Open a library in the publisher and copy its **MCP link**. Put that URL in `.cursor/mcp.json` (replace `PASTE_LIBRARY_ID`) with client id `mpos-mcp`. In **Settings → Tools & MCP**, connect **publisher**. Cursor will 401, discover the IdP, and open a browser login.

Use `127.0.0.1` consistently. `localhost` is a different token audience and login will fail. The token audience is that library URL.

Cursor’s desktop OAuth return URL is `http://localhost:8787/callback`. Leave that port free while connecting (the kiosk does not use 8787; it returns to its own `/oauth/callback`). The built-in sign-in accepts that address, and any other client’s callback, without adding it to a list. The sign-in page shows where you will be sent back.

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

## MCP tools (Lookups)

Each connection is one library. Lookups do not take a library name or id.

| Tool | Permission | Returns |
| --- | --- | --- |
| `whoami` | any library role | sub, library, role, permissions |
| `list_items` | `records.read` | Pass `q` to answer. One clear match returns the full item. Several matches return short summaries. Omit `q` to browse names and summaries. |
| `open_item` | `records.read` | full Markdown for one id (when `list_items` returned several matches) |
| `create_item` / `update_item` | `records.write` | name, body / template fields, labels — always saves as **draft** |
| `delete_item` | `records.delete` | by id only |
| `list_audit` | `audit.read` | who invoked which tool |

There is no publish tool and no `run_sql` tool. Publishing is a human action in the UI. Queries are parameterized in code.

## Security notes (why it is built this way)

- In **oidc** mode MCPEncode is only a resource server and does not issue tokens. The default **embedded** mode runs a development IdP in-process (OAuth 2.1 + PKCE). Do not expose that to a network. MCP clients may return to any absolute callback URL (the browser sign-in for this app still returns only to its own `/callback`). The code is single-use and PKCE is required. Keycloak’s `mpos-mcp` client uses the same open callback list (`*`); import the realm again if Keycloak was already running with the old list.
- Access tokens must pass signature, issuer, expiry, and **audience** = the library MCP URL (or `AUTH_AUDIENCE` / `PUBLIC_BASE_URL` for the web UI).
- Library access is an allow-list of IdP subjects (`sub`) with reader or publisher role.
- The access token is never written to Postgres. Only the user id (`sub`) is stored as `created_by` / `updated_by` / access subjects.

- Tool results label store content as **data**, not instructions (indirect prompt injection).
- The Markdown preview **does not execute raw HTML** in item bodies.
- Pasted Word/Docs HTML is converted to Markdown before save.
- The UI session is an httpOnly cookie. Forms carry a CSRF token.
- The HTTP server binds to `127.0.0.1` by default. Postgres is published on `127.0.0.1:5432`. The app connects as user `mpos`. Queries stay parameterized. Remote Postgres requires `POSTGRES_SSL=required` (certificate verified). Each connection sets a 15s statement timeout.

## Tests

```bash
npm test
```

Verifier tests mint local JWTs and do not need Docker. Tests that touch libraries or items need Postgres (`docker compose up -d postgres`).

## Layout

- `src/auth/` — JWKS verifier, role → permission map, UI session, embedded IdP
- `src/db/` — Postgres connection, migrations, and domain queries (`libraries`, `items`, `lookup`, `audit`); `queries.ts` is the public barrel
- `src/http/` — Express composer (`app.ts`), `routes/` by URL area, `pages/` HTML renderers, OAuth helpers
- `src/items/` — Zod schemas and Policy / Procedure templates
- `src/markdown/` — sanitize, preview, table ↔ Markdown
- `src/mcp/` — tools (search-then-fetch)
- `migrations/` — Postgres SQL applied once on startup (`mariadb_archive/` is historical only, not applied). Does not drop `records`.
- `public/` — browser editor and styles
- `keycloak/` — realm import (two users, two clients, audience mapper)
- `AGENTS.md` — product vocabulary and run notes for agents

## Product freeze

See `AGENTS.md`. Short version: `items` is source of truth (`name`, `labels`, `summary`, `body`, `status`); do not write to `records`; Lookups are `list_items` / `open_item` on a library MCP link; sections become first-class later — do not invent a third body shape now.

## Later (not this POC)

TLS on a public bind, org-admin role, optimistic concurrency, soft-delete, drop frozen `records`, publisher edit-schema UI, first-class sections (Table, Checklist, Details, Description), editable Lookup names in the UI.
