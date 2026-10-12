# AGENTS.md

Guide for AI coding agents (and humans) who need to deploy, verify, change or test MCPEncode. This is the canonical agent file; `CLAUDE.md` and `.cursor/rules/` point here.

## What it is

MCPEncode is a self-hosted web app and MCP server. People keep **Libraries** of **Items** and **Publish** them; AI agents connect to one Library through its **Connect link** (an MCP-over-HTTP URL) to look Items up and draft changes. With Review Lock (default) agent writes wait in Pending until a person Publishes. Roles: **Site admin** (app-wide), **Publisher** and **Reader** (per Library). More: [docs/concepts.md](docs/concepts.md).

## Stack

- Node.js 22+, TypeScript run directly by `tsx` (no build step), Express 5, MCP TypeScript SDK.
- PostgreSQL 16+ (17 also verified). The only state store; migrations in `migrations/` run automatically at startup.
- Built-in OAuth 2.1 + PKCE sign-in (default) or an external OIDC issuer ([docs/oidc.md](docs/oidc.md)).
- Tests: `node:test` via `tsx`, needs a Postgres. Lint: Biome. One container image ([`Dockerfile`](Dockerfile)).

## Repo map

| Path | What |
| --- | --- |
| `src/index.ts` | Startup: config → database + migrations → sign-in → HTTP server |
| `src/config.ts` | Reads and validates every environment variable (source of truth) |
| `src/env-schema.ts` | Machine-readable list of every variable: required, default, meaning |
| `src/auth/` | Built-in OAuth server (`embedded-idp.ts`), token checks, roles, sessions |
| `src/http/` | Express app (`app.ts`), routes, pages, rate limits, `/healthz` |
| `src/mcp/` | MCP server and tools |
| `src/db/`, `migrations/` | Postgres client, queries, SQL migrations |
| `public/` | Browser JS and CSS |
| `test/` | Tests (`*.test.ts`) |
| `scripts/init-env.sh` | Creates/completes `.env` with random secrets (idempotent) |
| `scripts/check-env.ts` | `npm run check-env`: validates `.env` without starting anything |
| `docs/` | Deploy, OIDC, concepts, limitations, develop |

## Deploy

### A. Local Docker Compose (default)

```bash
git clone https://github.com/hkrlogic/MCPEncode.git && cd MCPEncode
scripts/init-env.sh              # writes .env: SESSION_SECRET, SETUP_TOKEN, POSTGRES_PASSWORD
docker compose up -d --build     # app on 127.0.0.1:3000, Postgres 16 on 127.0.0.1:5432
curl -s http://127.0.0.1:3000/healthz
```

To use another port, set `PORT=` and `PUBLIC_BASE_URL=http://127.0.0.1:<port>` in `.env` before `up`.

### B. Any container host (VM, Kubernetes, PaaS)

Build the image, run **one** replica next to a PostgreSQL 16+ database, behind a TLS reverse proxy:

```bash
docker build -t mcpencode .
docker run -d --init --name mcpencode -p 127.0.0.1:3000:3000 \
  -e PUBLIC_BASE_URL=https://library.example.org \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e SETUP_TOKEN="$(openssl rand -base64 18)" \
  -e DATABASE_URL=postgresql://USER:PASSWORD@DBHOST:5432/DBNAME \
  -e POSTGRES_SSL=required \
  -e TRUST_PROXY=1 \
  mcpencode
```

Store `SESSION_SECRET` and `SETUP_TOKEN` in the platform's secret store; generate them once, not on every deploy (a new `SESSION_SECRET` signs everyone out). Readiness/liveness probe: `GET /healthz`. Details: [docs/deploy.md](docs/deploy.md).

### C. Without Docker (Node + an existing Postgres)

```bash
npm ci
scripts/init-env.sh
# point .env at your database: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_DATABASE
# (POSTGRES_PASSWORD was generated; replace it with the real one) or set DATABASE_URL
npm run check-env
npm start
```

The database user must own the database (it creates tables). It does not need superuser.

## Environment

Required:

- `SESSION_SECRET`: 32+ random characters. `scripts/init-env.sh` sets it.
- A database password: `POSTGRES_PASSWORD`, or `DATABASE_URL`.
- With `AUTH_MODE=oidc` only: `AUTH_ISSUER` and `AUTH_MCP_AUDIENCE`.

Set on every real deploy: `PUBLIC_BASE_URL` (the `https://` address people open), `SETUP_TOKEN` (16+ characters), and `TRUST_PROXY` (e.g. `1`) when behind a reverse proxy.

Everything else is optional with working defaults. Full table with defaults: [docs/deploy.md#environment](docs/deploy.md#environment), same data as code in [`src/env-schema.ts`](src/env-schema.ts). `npm run check-env` reports missing, removed (ignored) and unknown variables in `.env`.

## Verify

1. **Health:** `curl -s http://127.0.0.1:3000/healthz` returns HTTP 200 and exactly `{"status":"ok","database":"ok"}`. HTTP 503 `{"status":"unavailable","database":"unreachable"}` means the app runs but cannot reach Postgres.
2. **Startup log** (`docker compose logs app`) says `No account exists yet. The create-account page asks for your SETUP_TOKEN.` on a fresh database.
3. **First account:** open `PUBLIC_BASE_URL`, click **Sign in**. On a fresh database the page asks for a setup code, username and password (12+ characters, typed twice). The setup code is `SETUP_TOKEN` from `.env` (`grep ^SETUP_TOKEN= .env`; do not print it into shared logs). The first account is the Site admin. If `SETUP_TOKEN` is unset, a one-time code is printed in the startup log instead.
4. **Connect link:** signed in, open a Library (a fresh install has one named **Main**; **+** next to Libraries adds another) and click **Connect**. The dialog shows the link `PUBLIC_BASE_URL/libraries/<id>/mcp/<token>`. Paste it into an MCP client (Cursor, Claude Code: `claude mcp add --transport http <name> <link>`); the client signs in through the browser and asks to **Allow**.
5. **Unauthenticated MCP request** to the link answers `401` with a `WWW-Authenticate` header pointing at the sign-in metadata. That is expected: clients sign in first.

## Common failures

| Symptom | Fix |
| --- | --- |
| Compose: `Set POSTGRES_PASSWORD in .env (run scripts/init-env.sh)` | Run `scripts/init-env.sh`, then `docker compose up -d` again. |
| `Missing required environment variable SESSION_SECRET` / `Database password is missing` | Run `scripts/init-env.sh` (adds only missing secrets), or set them in the platform's secret store. |
| `Cannot reach Postgres at host:port` or retry lines at startup | Database not ready or wrong host. The app retries for `POSTGRES_CONNECT_TIMEOUT_SECONDS` (60); start Postgres first, check `POSTGRES_HOST`, then restart the app. |
| `password authentication failed` | `.env` password differs from the one the Postgres volume was created with. Postgres reads it only on first volume creation: use the old password, or (losing data) `docker compose down -v`. |
| `POSTGRES_SSL must be set for a remote host` | Set `POSTGRES_SSL=required` (or `disable` on a trusted private network). |
| `PUBLIC_BASE_URL is plain http on a non-loopback host` | Use `https://` behind a TLS proxy (or `ALLOW_INSECURE_HTTP=true`, not recommended). |
| 403 on every page behind a proxy | The proxy's Host header must match `PUBLIC_BASE_URL` or `ALLOWED_HOSTS`. |
| Log: `X-Forwarded-For` but `TRUST_PROXY` not set; everyone rate limited together | Set `TRUST_PROXY=1` (one proxy) or the proxy addresses. Never `true`. |
| `AUTH_MCP_AUDIENCE is required when AUTH_MODE=oidc` | Set `AUTH_MCP_AUDIENCE` to the audience your issuer puts in MCP tokens ([docs/oidc.md](docs/oidc.md)). |
| `... is no longer supported and is ignored` | Harmless. Delete that variable from `.env`. |
| A value in `.env` seems ignored (`npm start`) | A variable already exported in the shell wins over `.env`. `unset` it or start from a clean shell. The startup log line `Postgres host:port/database` shows what was used. |
| `That setup code is not correct.` | Use `SETUP_TOKEN` from the `.env` the app actually loaded (Compose reads `.env` at `up`; restart after editing). |
| MCP client: `invalid redirect_uri` | Hosted clients (e.g. claude.ai) need their host in `OAUTH_REDIRECT_HOSTS`. Desktop clients must use a loopback or app-scheme callback. |

## Develop, test, lint

```bash
npm ci
npm run typecheck
npm run lint                # Biome
npm test                    # needs Postgres; see below
```

Tests read the same `POSTGRES_*` / `DATABASE_URL` settings and create a throwaway `mcpencode_test_*` database per test, so the role needs `CREATEDB` (the Compose user has it): `docker compose up -d postgres && npm test`. With another Postgres, export `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` first. More: [docs/develop.md](docs/develop.md).

## Rules for contributing agents

- Use the product words exactly: Library, Item, Publish, Connect link, Reader, Publisher, Site admin, Review Lock / Review Unlock. No synonyms (vault, notebook, record, document).
- `src/config.ts` is the source of truth for settings. Adding, renaming or removing an environment variable means updating `src/env-schema.ts`, the table in `docs/deploy.md` and `CHANGELOG.md`; `test/env-schema.test.ts` fails otherwise. Prefer a constant to a new setting.
- Never add an MCP tool that publishes, approves, reverts or changes a Library's write mode. Those stay with people.
- No inline `<script>` or `on…=` handlers (strict CSP; a test checks).
- Database changes go in a new numbered file in `migrations/`; never edit an applied one.
- Run typecheck, lint and tests before proposing a change. Keep pull requests small; open an issue first for large changes.
- Do not edit CI workflows (`.github/workflows/`) in feature changes, and never commit secrets, `.env` or real customer data (use example data in tests and screenshots).
- Security issues: follow [SECURITY.md](SECURITY.md), not a public issue.
