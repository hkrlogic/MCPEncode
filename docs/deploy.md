# Deploy

MCPEncode is one Node.js container plus PostgreSQL 16 or later. It runs on any host that runs containers (a VM with Docker Compose, Kubernetes, a container platform). Nothing is provider-specific: all configuration comes from the environment variables below, and database migrations run at startup.

Short version for agents and scripts: [AGENTS.md](../AGENTS.md).

## Local or single server: Docker Compose

```bash
scripts/init-env.sh            # creates .env with random secrets, including SETUP_TOKEN
docker compose up -d --build
curl http://127.0.0.1:3000/healthz   # {"status":"ok","database":"ok"}
```

[`docker-compose.yml`](../docker-compose.yml) runs the app and Postgres 16, both published on `127.0.0.1` only. Open the URL, enter `SETUP_TOKEN` from `.env`, and create the first account (the Site admin).

For a public address, put a TLS reverse proxy in front (below) and set `PUBLIC_BASE_URL` in `.env` to the `https://` address.

To start over with an empty database, run `docker compose down -v` (this deletes the Postgres volume). Compose reads `.env` even to stop the stack, so it needs one: if `.env` is missing, run `scripts/init-env.sh` first.

`scripts/init-env.sh` is safe to re-run: it never changes a value that is already set and only adds missing secrets. It never prints them. `npm run check-env` checks a `.env` without starting anything.

## Any container host: the image

```bash
docker build -t mcpencode .
docker run --init -p 127.0.0.1:3000:3000 \
  -e PUBLIC_BASE_URL=https://library.example.org \
  -e SESSION_SECRET=... -e SETUP_TOKEN=... \
  -e DATABASE_URL=postgresql://mcpencode:...@db.example.internal:5432/mcpencode \
  -e POSTGRES_SSL=required \
  -e TRUST_PROXY=1 \
  mcpencode
```

The image runs as the unprivileged `node` user, listens on `0.0.0.0:$PORT` (default 3000), has a Docker `HEALTHCHECK` on `/healthz`, and applies migrations at startup. Generate secrets with `openssl rand -base64 48` (`SESSION_SECRET`) and `openssl rand -base64 18` (`SETUP_TOKEN`). The database role must own its database (it creates tables); it does not need `CREATEDB`.

**Run exactly one replica.** Pending sign-ins and rate-limit counters live in memory (see [known limitations](known-limitations.md)).

## Environment

Every setting the app reads. [`src/env-schema.ts`](../src/env-schema.ts) is the same list in machine-readable form, [`src/config.ts`](../src/config.ts) parses it, and a test keeps all three in sync. Only `SESSION_SECRET` and a database password are strictly required; set `SETUP_TOKEN` and `PUBLIC_BASE_URL` on every real deploy.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | no | `http://127.0.0.1:3000` | Address people open. https:// unless loopback. |
| `PORT` | no | `3000` | Port the app listens on. |
| `BIND_HOST` | no | `127.0.0.1` | Interface to listen on. The container image sets 0.0.0.0. |
| `SESSION_SECRET` | yes | – | Signs the session cookie. 32+ random characters (scripts/init-env.sh). |
| `SETUP_TOKEN` | no | – | Code the first-account page asks for (16+ characters). Unset: a random one is printed to the log. |
| `POSTGRES_HOST` | no | `127.0.0.1` | Database host. Compose sets postgres. |
| `POSTGRES_PORT` | no | `5432` | Database port. |
| `POSTGRES_USER` | no | `mcpencode` | Database user. |
| `POSTGRES_PASSWORD` | yes | – | Database password (or in DATABASE_URL). |
| `POSTGRES_DATABASE` | no | `mcpencode` | Database name. |
| `DATABASE_URL` | no | – | postgresql://user:password@host:5432/db, instead of the POSTGRES_* lines. |
| `POSTGRES_SSL` | no | – | required or disable. Must be set for a non-loopback database host. |
| `POSTGRES_CONNECT_TIMEOUT_SECONDS` | no | `60` | How long startup retries an unreachable database (0 = once). |
| `TRUST_PROXY` | no | – | Reverse proxies allowed to set X-Forwarded-For: hop count or addresses/CIDR/loopback/uniquelocal. Compose sets uniquelocal. |
| `ALLOWED_HOSTS` | no | – | Extra hostnames (comma-separated) that may reach the app. |
| `ALLOW_INSECURE_HTTP` | no | `false` | Accept a plain http PUBLIC_BASE_URL on a non-loopback host. Not recommended. |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | `300` | Library MCP requests per client address per minute. 0 turns it off. |
| `OAUTH_REDIRECT_HOSTS` | no | – | Remote https callback hosts approved up front, e.g. claude.ai. A Site admin can also approve hosts in the app (Settings → Apps). |
| `AUTH_MODE` | no | `embedded` | embedded (built-in accounts) or oidc (external issuer, docs/oidc.md). |
| `AUTH_ISSUER` | oidc mode | – | External issuer URL. |
| `AUTH_AUDIENCE` | no | `PUBLIC_BASE_URL` | Audience of web sign-in tokens. |
| `AUTH_MCP_AUDIENCE` | oidc mode | – | Audience of library MCP tokens, kept separate from AUTH_AUDIENCE. |
| `AUTH_JWKS_URL` | no | `AUTH_ISSUER/protocol/openid-connect/certs` | Issuer key set URL (oidc mode). Zitadel: AUTH_ISSUER/oauth/v2/keys. |
| `WEB_CLIENT_ID` | no | `mcpencode-web` | Client id of the web app at the issuer (oidc mode). |

`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `POSTGRES_DB` are read as fallbacks for the matching `POSTGRES_*` setting. The `POSTGRES_*` settings override the matching part of `DATABASE_URL`.

**Fixed, not configurable:** client registrations 20 per address per hour; sign-in page 60 per address per minute; at most 1000 unused client registrations (20 per address, IPv6 per /64), dropped after 60 minutes; a sign-in's refresh tokens end 30 days after sign-in; 2 password hashes at once.

**Removed settings.** These were removed in 0.1. If one is still set, the app starts, ignores it and logs one line naming it: `OAUTH_LEGACY_CLIENT`, `OAUTH_REGISTER_RATE_LIMIT`, `OAUTH_AUTHORIZE_RATE_LIMIT`, `OAUTH_MAX_PENDING_CLIENTS`, `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS`, `OAUTH_PENDING_CLIENT_TTL_MINUTES`, `PASSWORD_HASH_CONCURRENCY`, `OAUTH_REFRESH_MAX_DAYS`, `OAUTH_ALLOWED_SCHEMES`, `OAUTH_ALLOW_ANY_HTTPS_REDIRECT`, `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL`, `AUTH_MCP_AUDIENCE_SHARED`, `ALLOW_OPEN_SETUP`.

External sign-in (`AUTH_MODE=oidc`, Zitadel or another issuer): [oidc.md](oidc.md).

## Health check

`GET /healthz` needs no auth and is answered before the Host check, so platform probes with an internal Host header work.

- `200 {"status":"ok","database":"ok"}` when Postgres answers.
- `503 {"status":"unavailable","database":"unreachable"}` when it does not (3 second limit). The reason is logged, not returned.

The image has a Docker `HEALTHCHECK` on it. Point your load balancer or orchestrator readiness probe at `/healthz`.

## TLS and reverse proxy

The built-in sign-in sends passwords and session cookies, so a public address must use HTTPS. Terminate TLS in a reverse proxy (Caddy, nginx, Traefik, or your platform's load balancer) and forward to the container:

- Set `PUBLIC_BASE_URL` to the `https://` address. The Host header the proxy forwards must match that hostname (or one in `ALLOWED_HOSTS`); other hosts get 403.
- Set `TRUST_PROXY` so the sign-in throttle sees the browser's address, not the proxy's. **Prefer `TRUST_PROXY=1` behind a single reverse proxy**, including intranet deploys: it trusts exactly one hop, whatever the proxy's address. It is off by default: without it every visitor shares the proxy's address. `1` trusts one hop; a list (`127.0.0.1`, `10.0.0.0/8`, `loopback,uniquelocal`) trusts only proxies at those addresses, which is safer. [`docker-compose.yml`](../docker-compose.yml) sets `uniquelocal`, because a proxy on the host reaches the container from the Docker bridge (a private address); override it in `.env`. The proxy must set `X-Forwarded-For` itself (Caddy and Traefik do; in nginx, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Do not expose the container port directly to the internet alongside the proxy, or anyone could choose their own address.
- **A wrong `TRUST_PROXY` behind a proxy makes every visitor share one address** (the proxy's). Then the per-address budgets become global: client registration, the sign-in page, pending registrations per address, `MCP_RATE_LIMIT_PER_MINUTE` and the sign-in throttle are spent by everyone together, so one noisy client can lock everybody out of registering or signing in. When `TRUST_PROXY` is unset and a request arrives with `X-Forwarded-For`, the app logs one warning saying so. Set it, restart, and the warning stops.
- Limit sign-in at the proxy as well: the app's counters live in one process and cannot see a flood before it arrives. For example, in nginx `limit_req_zone $binary_remote_addr zone=signin:10m rate=10r/m;` with `limit_req zone=signin burst=10 nodelay;` on `location = /id/authorize` (POST) and `/id/token`; in Caddy, a rate-limit plugin or your platform's WAF.
- The sign-in throttle remembers, for 30 days, each address a username signed in from successfully (IPv6 per /64), so a distributed password guess cannot keep the SA out of their usual place. These are kept in Postgres (table `signin_known_good`, migration 016) as a SHA-256 of username + address, never in the clear, capped at 10,000 rows, and survive a restart.
- Set `TRUST_PROXY` for the MCP rate limit too (below): without it every client behind the proxy shares one count.
- Rotating a Connect link (**Connect → Rotate**) invalidates the old token in both forms at once: the path form and the `X-Library-Token` header value are the same token, checked against the library on every request. An agent using the header must be given the new value.
- Keep Connect tokens out of access logs. A Connect link carries its token in the path (`/libraries/<id>/mcp/<token>`). Either connect clients that can set headers to `/libraries/<id>/mcp` with `X-Library-Token: <token>`, or drop the path from proxy logs, e.g. in nginx `map $request_uri $loggable { ~^/libraries/[^/]+/mcp/ 0; default 1; }` with `access_log … if=$loggable;`, or log a rewritten `$uri` with the last segment removed. The same applies to the RFC 9728 metadata path `/.well-known/oauth-protected-resource/libraries/<id>/mcp/<token>`.
- Libraries created before migration 007 had md5-derived Connect tokens. Migration 015 replaces them once with random ones; agents using one of those old links must copy the new link from **Connect**.
- Keep Postgres off the public internet. If it is remote, use `POSTGRES_SSL=required`.

## MCP client sign-in

With built-in sign-in, each MCP client registers itself (`/id/register`) and gets its own client id, tied to the callbacks it registered. After the password, the person sees a consent page naming the client, the host the sign-in is sent to, and the library, and chooses **Allow** or **Deny**.

| Callback | Accepted | Typical clients |
| --- | --- | --- |
| `http://127.0.0.1:<port>/…`, `http://[::1]:<port>/…`, `http://localhost:<port>/…` | always | Claude Code, Claude Desktop via `mcp-remote`, MCP Inspector, VS Code, Cursor |
| Reverse-DNS app scheme with a dot, e.g. `com.example.app:/…` (RFC 8252 §7.1) | always | native apps |
| `cursor:`, `vscode:`, `vscode-insiders:`, `claude:` | always | Cursor, VS Code, Claude |
| Other single-word schemes, browser launchers and OS handlers (`microsoft-edge:`, `x-safari-*`, `googlechrome(s):`, `firefox:`, `ms-*`, `file:`, `javascript:`, …), or an app scheme whose path holds another URL | never | |
| `https://<host>/…` (a DNS name; no IP address, user info or fragment) | once `<host>` is approved: by a Site admin in the app, or listed in `OAUTH_REDIRECT_HOSTS` | Claude custom connectors (`claude.ai`), Perplexity (`www.perplexity.ai`) |
| `http://<remote host>/…` | never | |

A loopback or app-scheme callback can only be received on the person's own machine (RFC 8252). An app scheme is still only as trustworthy as the app that claimed it, so **the consent page is the guard**: it shows the full callback address, the client id, and the client's self-declared name marked unverified. A loopback IP callback may come back on a different port (RFC 8252 §7.3); everything else must match exactly.

### Approving apps

A hosted web app (a web chat's MCP connector) sends people back to its own `https://` address after sign-in. That host must be approved once; arbitrary https hosts are never accepted on their own.

1. Someone connects the app. Its registration is kept, and its host is listed as **waiting** (Settings → **Apps**). No sign-in code goes to it yet. The log says, once per host and client:
   `OAuth callback host not approved: host=client.example.test client_id=mcp_… client_name="…" (self-reported, unverified)…` followed by a copy-paste line `OAUTH_REDIRECT_HOSTS=client.example.test`.
2. The browser shows *"This app's callback host … isn't approved yet. A site admin can approve it."*
   - A **Site admin** who signs in there gets **Approve <host> and continue**, then the normal Allow page.
   - Anyone else sees *"Waiting for your site admin to approve this app."* After approval they start again from the app.
3. Or a Site admin opens Settings → **Apps** and clicks **Approve** or **Deny**. **Revoke** on an approved host denies it and deletes the refresh tokens of every client with a callback on it; access tokens already issued run out within 15 minutes.

Approved hosts are the ones approved in the app plus `OAUTH_REDIRECT_HOSTS` (set it to pre-approve hosts without the UI; hosts from the environment cannot be revoked in the app). Every decision is written to the audit log (`callback_host.approve`, `.deny`, `.revoke`). At most 200 hosts wait at once, and one address may add 10 new waiting hosts per hour; past that, `/id/register` answers with an error naming the host. Callbacks still match the registered address exactly. Approving a host trusts every app that can receive requests on it, so approve only hosts you recognise (for example `claude.ai`).

### Sign-in lifetime

Access tokens last 15 minutes. Refresh tokens rotate on every use and are stored hashed in Postgres, so a restart or a redeploy keeps people signed in. A refresh token not used for 12 hours expires, and a sign-in ends 30 days after it started. If a refresh token that was already used comes back, the whole sign-in is revoked: either the client or someone who copied the token holds it, and both must sign in again.

Sign-out and a Site admin password reset sign that account out everywhere: other browser sessions, MCP access tokens and refresh tokens.

The token signing key is stored in Postgres, encrypted with a key derived from `SESSION_SECRET`. **Changing `SESSION_SECRET` rotates the signing key too:** the old key can no longer be decrypted, a new one is made, and every browser session, MCP access token and refresh token stops working, so everyone signs in again. Plan a rotation like a forced sign-out.

## MCP rate limit

Both library MCP routes, the Connect link (`/libraries/<id>/mcp/<token>`) and the `X-Library-Token` form (`/libraries/<id>/mcp`), share one limit of `MCP_RATE_LIMIT_PER_MINUTE` requests per client address per minute (default 300). Every MCP message is one request, so 300 is several busy agents' worth from one address; raise it if many agents share an address (a NAT, a kiosk host), or set `0` to turn it off and limit at the proxy instead.

- The client address is Express's `req.ip`, so it follows `TRUST_PROXY`. Off (the default), it is the socket peer and `X-Forwarded-For` is ignored, so a client cannot pick a fresh address per request. Behind a trusted proxy it is the browser or agent's address from `X-Forwarded-For`. IPv6 clients are counted per /56; IPv4-mapped IPv6 addresses count as their IPv4 address.
- Responses carry the IETF `RateLimit-Policy` and `RateLimit` headers (draft 8). Over the limit the app answers `429` with `Retry-After` and a JSON-RPC error body: `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Too many requests …"},"id":null}`.
- CORS preflights (`OPTIONS`) are not counted.
- Counts live in memory in one process and reset on restart. With several app replicas, each counts on its own; limit at the proxy or load balancer as well.

## Startup and the database

If Postgres is not reachable when the app starts (connection refused, unknown host, timeout, or "the database system is starting up"), the app retries with an exponential backoff (0.5s, 1s, 2s, 4s, then every 5s) for up to `POSTGRES_CONNECT_TIMEOUT_SECONDS` (default 60). An attempt still running when the window closes (for example a slow DNS lookup for a stopped Compose service) counts as a timeout. Each retry logs one line with the host, port and error code, never the password. If Postgres is still unreachable after that, the app exits non-zero with `Cannot reach Postgres at host:port`, so your orchestrator can restart it.

A wrong password, a missing database or a configuration error is not retried: the app exits at once with the error.

## Upgrades

1. Back up the database (below).
2. Pull the new code or image and read [CHANGELOG.md](../CHANGELOG.md) for breaking changes.
3. `docker compose up -d --build` (or roll out the new image). Migrations run at startup; if one fails, the app exits with the error instead of serving.
4. Check `/healthz` and the startup log. A line ending in `is no longer supported and is ignored` names a setting to delete from `.env`.

Re-run `scripts/init-env.sh` after an upgrade: it adds any newly required secret and changes nothing else. Changing `SESSION_SECRET` signs everyone out (it also encrypts the token signing key).

## Backups

Everything (accounts, libraries, items, history, uploads, the signing key) is in Postgres. Back it up with `pg_dump`; there is no other state to save.

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > mcpencode-$(date +%F).dump
# restore into an empty database:
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < mcpencode-YYYY-MM-DD.dump
```

Treat backups as secret: Connect tokens are stored in plain text (see [known limitations](known-limitations.md)). Keep `.env` (or your secret store) too; without the same `SESSION_SECRET` a restored database still works, but everyone signs in again.

## Postgres version

Compose runs **PostgreSQL 18**. CI runs the test suite on PostgreSQL 16, and the app is also verified on 17 and 18. Any of 16–18 works for an external database.

### Postgres 16 to 18 (Compose)

Postgres 18's image stores data in a versioned subdirectory and refuses a volume mounted at `/var/lib/postgresql/data`. Compose therefore mounts a **new** volume, `postgres18_data`, at `/var/lib/postgresql`. The old `postgres_data` volume (Postgres 16 data) is left untouched, but **it is not read by Postgres 18**: if you simply pull and run `docker compose up`, the app starts on an empty database and asks for a setup code. Your data is still in the old volume. Choose one:

**A. Move the data to Postgres 18 (recommended).** Dump with the old version, restore into the new one:

```bash
# 1. Stop the app, start the OLD Postgres 16 on the old volume, and dump it
set -a; . ./.env; set +a
docker compose stop app
docker run -d --name pg16-old -v mcpencode_postgres_data:/var/lib/postgresql/data postgres:16
sleep 5
docker exec pg16-old pg_dump -U "${POSTGRES_USER:-mcpencode}" -Fc "${POSTGRES_DATABASE:-mcpencode}" > mcpencode-pg16.dump
docker rm -f pg16-old
# 2. Start Postgres 18 on the new volume and restore
docker compose up -d postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' < mcpencode-pg16.dump
# 3. Start the app and check /healthz; sign in with your existing account
docker compose up -d --build
# 4. Only when everything is there: docker volume rm mcpencode_postgres_data
```

(The volume name is `<project>_postgres_data`; `docker volume ls` shows it. If you ran the app on the new volume before restoring, start from an empty one: `docker compose down`, `docker volume rm mcpencode_postgres18_data`, then step 2.)

**B. Stay on Postgres 16 for now.** Add a `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    volumes: !override
      - postgres_data:/var/lib/postgresql/data
volumes:
  postgres_data:
```

`pg_upgrade --link` also works if you prefer an in-place upgrade; dump and restore is simpler and the database is small.
