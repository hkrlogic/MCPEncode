# MCPEncode (Publisher)

This is the **publisher** surface (**MCPEncode**). It lives in `~/MCPEncode` and is separate from the kiosk workspace (`~/organization-chat`). GitHub: [hkrlogic/MCPEncode](https://github.com/hkrlogic/MCPEncode).

A **POC** of a Model Context Protocol (MCP) server with real OAuth 2.1 login, two roles, libraries of items in PostgreSQL, and a localhost Markdown UI. MCP is the connector; the product words are **library**, **item**, and **section**.

OAuth 2.1 proves who you are. **MCPEncode** only checks the access token, maps the role to permissions, then lets Cursor and the browser use the same libraries.

Sign-in is built into the app. The first visit creates the account. Passwords are hashed in PostgreSQL. There is no shared demo password. OAuth 2.1 authorization-code + PKCE still lets Cursor and other clients sign in. An external identity provider is optional (`AUTH_MODE=oidc`). The library access list still decides who can open each library.

## What you get

| Piece | Role |
| --- | --- |
| Identity | OAuth 2.1 authorization code + PKCE. Accounts and scrypt password hashes live in PostgreSQL. |
| Roles | IdP **read-only** / **edit** for sign-in and adding libraries. Per library: **reader** / **publisher** on the access list (by IdP `sub`). |
| Permissions | Tools and the UI check `records.read` / `records.write` / `records.delete` / `audit.read` from the library role. |
| PostgreSQL | Libraries and items live in database `mpos`. Each item has a name, labels (JSONB), a required summary, a body, and a status. Reads and writes use `items`. The older `records` table is **frozen** (kept, not dropped; no new writes). |
| Status gate | Items: **Pending** (`draft`) → **Published** → optional **Archived**. Each library is **Reviewed** or **Live Sync**. Reviewed: edit saves a draft (published items unpublish on edit); Publish is a UI action. Live Sync: successful saves are Published immediately. Readers and reader MCP only see published. |
| Cursor | One MCP link per library under **Connect** (includes a secret; rotate under Actions). Global `/mcp` is retired. |
| Browser | `http://127.0.0.1:3000/` — signed-out landing, then libraries you can open. General libraries use a Jspreadsheet CE grid (first row = titles) saved as Markdown tables; Policy and Procedure libraries use fixed fields. |

Read-only callers never see write tools in Cursor, and the add/edit forms are omitted in the UI.

## Prerequisites

- Node.js 22+
- Docker Desktop (PostgreSQL). Zitadel is optional and not required to sign in.

## Run

```bash
cd ~/MCPEncode
docker compose up -d postgres
npm install
npm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and choose **Sign in**. The first visit asks you to create the account (username, password of at least 12 characters). That account can add libraries. Later visits are a normal sign-in. Postgres listens on `127.0.0.1:5432` only. Connection settings are in `.env` (see `.env.example`).

An editor can open **Accounts** to create more people. Copy a subject from that page and grant it on a library. There are no built-in usernames or passwords.

### Cursor

Open a library in the publisher and copy its **MCP link**. Put that URL in `.cursor/mcp.json`. With the built-in sign-in, the client id is `mpos-mcp`. After Zitadel bootstrap, the client id and scopes in that file are the ones Zitadel generated. In **Settings → Tools & MCP**, connect **publisher**. Cursor will 401, discover the issuer, and open a browser login.

Use `127.0.0.1` consistently. `localhost` is a different host. With the built-in sign-in, the token audience is that library URL. With Zitadel, the token audience is the Zitadel project, and the access list still gates the library.

Cursor’s desktop OAuth return URL is `http://localhost:8787/callback`. Leave that port free while connecting (the kiosk returns to `http://127.0.0.1:8765/oauth/callback`). The built-in sign-in accepts any absolute callback. Zitadel only accepts the callbacks registered by bootstrap: Cursor’s desktop URL, Cursor’s app URL, and the kiosk URL.

### Zitadel

Start **Docker Desktop** first. Then:

```bash
docker compose up -d
npm run zitadel:bootstrap
npm start
```

Bootstrap writes `AUTH_MODE=oidc`, the issuer `http://127.0.0.1:8080` (or `ZITADEL_HOST_PORT` if you changed it), the project id as `AUTH_AUDIENCE`, and both client ids. The admin console is that same origin. The admin login name is `zitadel-admin@mcpencode.127.0.0.1` (Zitadel adds the organization domain). The password is `ZITADEL_ADMIN_PASSWORD` in `.env`. Set `ZITADEL_EDITOR_PASSWORD` and `ZITADEL_READER_PASSWORD` before bootstrap if you want those two users. Do not commit those passwords.

`ZITADEL_MASTERKEY` must stay the same for the life of the Zitadel database. People you add later are created in that console. Put their Zitadel user id (`sub`) on a library access list.

## MCP tools (Lookups)

Each connection is one library. Lookups do not take a library name or id.

| Tool | Permission | Returns |
| --- | --- | --- |
| `whoami` | any library role | sub, library, role, permissions |
| `list_items` | `records.read` | Pass `q` to answer. One clear match returns the full item. Several matches return short summaries. Omit `q` to browse names and summaries. |
| `open_item` | `records.read` | full Markdown for one id (when `list_items` returned several matches) |
| `create_library` | `records.write` | name, schema starter, **write_mode** (`reviewed` or `direct`); optional table proposal |
| `create_item` / `update_item` | `records.write` | name, body / template fields, labels — **Reviewed** saves as draft; **Live Sync** saves as published |
| `delete_item` | `records.delete` | by id only |
| `list_audit` | `audit.read` | who invoked which tool |

There is no publish tool, no write-mode tool, and no `run_sql` tool. In Reviewed libraries, publishing is a human action in the UI. Write mode can only be changed in the publisher UI. Live Sync library MCP instructions tell agents to prefer `entity_key` for upserts, search before create, keep one item per entity, and use a stable name, summary, and labels so another agent can scoop the data. Queries are parameterized in code.

## Security notes (why it is built this way)

- In **oidc** mode MCPEncode is only a resource server and does not issue tokens. The default **embedded** mode runs a development IdP in-process (OAuth 2.1 + PKCE). Do not expose that to a network. MCP clients may return to any absolute callback URL (the browser sign-in for this app still returns only to its own `/callback`). The code is single-use and PKCE is required. Zitadel registers an explicit callback list (Cursor and the kiosk). It does not use a wildcard redirect.
- Access tokens must pass signature, issuer, expiry, and audience. Embedded mode requires the library MCP URL. Zitadel mode requires `AUTH_AUDIENCE` (the Zitadel project id) on every library link; the access list is the per-library check.
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
- `src/auth/zitadel-bootstrap.ts` — optional. Creates a Zitadel project, roles, and apps when `AUTH_MODE=oidc`
- `AGENTS.md` — product vocabulary and run notes for agents

## Product freeze

See `AGENTS.md`. Short version: `items` is source of truth (`name`, `labels`, `summary`, `body`, `status`); do not write to `records`; Lookups are `list_items` / `open_item` on a library MCP link; sections become first-class later — do not invent a third body shape now.

## Later (not this POC)

TLS on a public bind, org-admin role, optimistic concurrency, soft-delete, drop frozen `records`, publisher edit-schema UI, first-class sections (Table, Checklist, Details, Description), editable Lookup names in the UI.
