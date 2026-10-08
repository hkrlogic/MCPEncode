# Develop / run notes

Deeper operator notes for MCPEncode. Product words and the status gate live in [AGENTS.md](../AGENTS.md).

## Prerequisites

- Node.js 22+
- Docker (PostgreSQL). Zitadel is optional and not required to sign in.

## Run

```bash
docker compose up -d postgres
npm install
npm start
```

Open `http://127.0.0.1:3000/` and choose **Sign in**. The first visit creates the account (username, password of at least 12 characters). Postgres listens on `127.0.0.1:5432`. Connection settings are in `.env` (see `.env.example`).

An SA can open **Accounts** to create more people. Grant Access on a library by username (built-in sign-in) or IdP `sub` (OIDC). There are no shared demo passwords.

### Cursor

Open a library → **Connect** → put that URL in `.cursor/mcp.json`. With built-in sign-in, the client id is `mpos-mcp`. After Zitadel bootstrap, use the client id and scopes bootstrap wrote. In **Settings → Tools & MCP**, connect the library. Cursor will 401, discover the issuer, and open a browser login.

Use `127.0.0.1` consistently. `localhost` is a different host. Embedded mode: token audience is that library URL. Zitadel: audience is the Zitadel project; the access list still gates the library.

Cursor’s desktop OAuth return URL is `http://localhost:8787/callback`. Leave that port free while connecting. Embedded sign-in accepts any absolute callback. Zitadel only accepts the callbacks registered by bootstrap.

### Zitadel (optional)

```bash
docker compose up -d
npm run zitadel:bootstrap
npm start
```

Bootstrap writes `AUTH_MODE=oidc`, the issuer, `AUTH_AUDIENCE`, and client ids. Admin console is that origin. Do not commit real passwords. `ZITADEL_MASTERKEY` must stay the same for the life of the Zitadel database.

## MCP tools (Lookups)

Each connection is one library.

| Tool | Permission | Returns |
| --- | --- | --- |
| `whoami` | any library role | sub, library, role, permissions |
| `list_items` | `records.read` | Pass `q` to answer. One clear match returns the full item. Several matches return summaries. Omit `q` to browse. |
| `open_item` | `records.read` | full item for one id |
| `create_library` | `records.write` | name, schema starter, write_mode; optional table proposal |
| `propose_table` | `records.write` | table design for an empty library; human Approves |
| `propose_field` | `records.write` | one optional field to append; human Approves (cap 12) |
| `create_item` / `update_item` | `records.write` | Review Lock → draft; Review Unlock → published |
| `delete_item` | `records.delete` | by id |
| `list_audit` | `audit.read` | who invoked which tool |

No publish, approve, write-mode, or revert tools. Those stay in the publisher UI.

## Security notes

- Embedded mode is a development IdP in-process (OAuth 2.1 + PKCE). Do not expose it on a public network without understanding the tradeoffs.
- Access tokens must pass signature, issuer, expiry, and audience.
- Library access is an allow-list of subjects with reader or publisher role.
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
