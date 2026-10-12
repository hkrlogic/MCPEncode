# Deploy

MCPEncode ships as a container image built from the [`Dockerfile`](../Dockerfile). It runs on any host that runs containers (a VM with Docker Compose, Kubernetes, or a container platform) next to a PostgreSQL database. There is nothing provider-specific in the app: all configuration comes from the environment variables below.

> **Every deploy should set `SETUP_TOKEN`.** The first account is an SA, and the create-account page always asks for a setup code, local or public (a proxy on the same host makes every visitor look local). Without `SETUP_TOKEN` the page falls back to a one-time code printed in the server log, which anyone with log access can read. `ALLOW_OPEN_SETUP=true` skips the code; use it only on a throwaway local instance. `scripts/init-env.sh` generates one in `.env` (and adds one to an existing `.env` that has none, without touching other values). Otherwise set a 16+ character value (`openssl rand -base64 18`) before the app is reachable, and keep it secret.

## Quick start with Docker Compose

```bash
scripts/init-env.sh        # creates .env with random secrets, including SETUP_TOKEN
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

[`docker-compose.yml`](../docker-compose.yml) runs the app and Postgres 16. Both publish on `127.0.0.1` only. For a public address, put a TLS reverse proxy in front (see below) and set `PUBLIC_BASE_URL` in `.env` (keep the generated `SETUP_TOKEN`).

`scripts/init-env.sh` is safe to re-run: it never overwrites a value that is already set. On an existing `.env` it only adds a `SETUP_TOKEN` when there is none. It writes secrets to `.env` only and never prints them.

## Image only

```bash
docker build -t mcpencode .
docker run --init -p 127.0.0.1:3000:3000 \
  -e PUBLIC_BASE_URL=https://library.example.org \
  -e SESSION_SECRET=... -e SETUP_TOKEN=... \
  -e DATABASE_URL=postgresql://mpos:...@db.example.internal:5432/mpos \
  -e POSTGRES_SSL=required \
  mcpencode
```

The image runs as the unprivileged `node` user, listens on `0.0.0.0:$PORT` (default 3000) and applies database migrations at startup.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | yes (public) | The address people open, e.g. `https://library.example.org`. Used for OAuth issuer, token audience and Connect links. Default `http://127.0.0.1:3000`. |
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 48`). |
| `SETUP_TOKEN` | yes | Code needed to create the first account. 16+ characters. Without it a one-time code is printed to the log. |
| `ALLOW_OPEN_SETUP` | no | `true` lets the first visitor create the SA with no code. Default `false`. Local throwaway instances only. |
| `TRUST_PROXY` | behind a proxy | Which proxies may set the client address (`X-Forwarded-For`) for the sign-in throttle. Default off (the socket peer is the client). A hop count (`1`) or a list of addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`. `true` is refused. Compose sets `uniquelocal`. See [TLS and reverse proxy](#tls-and-reverse-proxy). |
| `PASSWORD_HASH_CONCURRENCY` | no | scrypt hashes run at once (64 MiB each). Default 2, 1–16. |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | Library MCP requests (`/libraries/<id>/mcp` and `/libraries/<id>/mcp/<token>`) per client address per minute. Default 300, 0 turns it off, at most 100000. The address follows `TRUST_PROXY`. See [MCP rate limit](#mcp-rate-limit). |
| `AUTH_MCP_AUDIENCE` | oidc mode | The audience library MCP tokens must carry, separate from `AUTH_AUDIENCE` (web sign-in). Unset: falls back to `AUTH_AUDIENCE` with a startup warning. Ignored with built-in sign-in, where each library link is its own audience. |
| `PORT` | no | Listen port. Default 3000. |
| `BIND_HOST` | no | Listen address. Default `127.0.0.1`; the image sets `0.0.0.0`. |
| `DATABASE_URL` | one of | `postgresql://user:password@host:port/database[?sslmode=require]` |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | one of | Separate settings. They override the matching part of `DATABASE_URL`. Standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` also work. |
| `POSTGRES_CONNECT_TIMEOUT_SECONDS` | no | How long startup keeps retrying while Postgres is unreachable. Default 60; `0` tries once. See [Startup and the database](#startup-and-the-database). |
| `POSTGRES_SSL` | for a remote database | `required` (verify TLS, preferred) or `disable` (trusted private network only). Not needed for `127.0.0.1`. |
| `ALLOWED_HOSTS` | no | Extra hostnames (comma-separated) beyond the one in `PUBLIC_BASE_URL`, e.g. `www.` |
| `OAUTH_REDIRECT_HOSTS` | no | Remote `https` hostnames (comma-separated) an MCP client may use as its sign-in callback, e.g. `claude.ai`. Loopback and app-scheme callbacks need no entry. See [MCP client sign-in](#mcp-client-sign-in). |
| `OAUTH_ALLOW_ANY_HTTPS_REDIRECT` | no | `true` accepts a callback on any `https` host. Default `false`. Only for a deploy where everyone who can sign in is trusted to judge the consent page. |
| `OAUTH_LEGACY_CLIENT` | no | Default `true`: the old shared client id `mpos-mcp` still signs in with loopback and app-scheme callbacks (and listed hosts). Set `false` once every client has reconnected. |
| `OAUTH_REFRESH_MAX_DAYS` | no | A sign-in's refresh tokens stop working this many days after sign-in, however often they are used. Default 30, 1–365. |

The database role needs to own its database (it creates tables on migration). It does not need `CREATEDB`.

## MCP client sign-in

With built-in sign-in, each MCP client registers itself (`/id/register`) and gets its own client id, tied to the callbacks it registered. After the password, the person sees a consent page naming the client, the host the sign-in is sent to, and the library, and chooses **Allow** or **Deny**.

Which callbacks a client may register:

| Callback | Accepted | Typical clients |
| --- | --- | --- |
| `http://127.0.0.1:<port>/…`, `http://[::1]:<port>/…`, `http://localhost:<port>/…` | always | Claude Code, Claude Desktop via `mcp-remote`, MCP Inspector, VS Code, Cursor |
| App scheme, e.g. `cursor://…`, `com.example.app:/…` | always | Cursor, native apps |
| `https://<host>/…` | only if `<host>` is in `OAUTH_REDIRECT_HOSTS`, or `OAUTH_ALLOW_ANY_HTTPS_REDIRECT=true` | Claude custom connectors (`claude.ai`), Perplexity (`www.perplexity.ai`) |
| `http://<remote host>/…` | never | |

These are the native-app rules of RFC 8252: a loopback or app-scheme callback can only be received on the person's own machine. A remote `https` callback could belong to anyone, which is why it is opt-in per host. A loopback IP callback may come back on a different port than it registered (RFC 8252 §7.3); everything else must match exactly.

**Upgrading from a release before client registration was stored:** every client used the fixed id `mpos-mcp` and any callback was accepted. After the upgrade:

- Everyone signs in once more (refresh tokens used to live in memory, and the signing key is new).
- Clients on loopback or app-scheme callbacks keep working with `mpos-mcp` while `OAUTH_LEGACY_CLIENT` is on (the default), now with the consent page. Reconnecting a client makes it register its own id.
- A client on a remote `https` callback stops working until its host is in `OAUTH_REDIRECT_HOSTS`; then reconnect it.

### Sign-in lifetime

Access tokens last 15 minutes. Refresh tokens rotate on every use and are stored hashed in Postgres, so a restart or a redeploy keeps people signed in. A refresh token not used for 12 hours expires, and a sign-in ends `OAUTH_REFRESH_MAX_DAYS` (default 30) after it started. If a refresh token that was already used comes back, the whole sign-in is revoked: either the client or someone who copied the token holds it, and both must sign in again.

Sign-out and an SA password reset sign that account out everywhere: other browser sessions, MCP access tokens and refresh tokens.

The token signing key is stored in Postgres, encrypted with a key derived from `SESSION_SECRET`. Changing `SESSION_SECRET` creates a new signing key, so everyone signs in again.

## Startup and the database

If Postgres is not reachable when the app starts (connection refused, unknown host, timeout, or "the database system is starting up"), the app retries with an exponential backoff (0.5s, 1s, 2s, 4s, then every 5s) for up to `POSTGRES_CONNECT_TIMEOUT_SECONDS` (default 60)." An attempt still running when the window closes (for example a slow DNS lookup for a stopped Compose service) counts as a timeout. Each retry logs one line with the host, port and error code, never the password. If Postgres is still unreachable after that, the app exits non-zero with `Cannot reach Postgres at host:port`, so your orchestrator can restart it.

A wrong password, a missing database or a configuration error is not retried: the app exits at once with the error.

## Health check

`GET /healthz` needs no auth and is answered before the Host check, so platform probes with an internal Host header work.

- `200 {"status":"ok","database":"ok"}` when Postgres answers.
- `503 {"status":"unavailable","database":"unreachable"}` when it does not (3 second limit). The reason is logged, not returned.

The image has a Docker `HEALTHCHECK` on it. Point your load balancer or orchestrator readiness probe at `/healthz`.

## TLS and reverse proxy

The built-in sign-in sends passwords and session cookies, so a public address must use HTTPS. Terminate TLS in a reverse proxy (Caddy, nginx, Traefik, or your platform's load balancer) and forward to the container:

- Set `PUBLIC_BASE_URL` to the `https://` address. The Host header the proxy forwards must match that hostname (or one in `ALLOWED_HOSTS`); other hosts get 403.
- Set `TRUST_PROXY` so the sign-in throttle sees the browser's address, not the proxy's. It is off by default: without it every visitor shares the proxy's address. `1` trusts one hop; a list (`127.0.0.1`, `10.0.0.0/8`, `loopback,uniquelocal`) trusts only proxies at those addresses, which is safer. [`docker-compose.yml`](../docker-compose.yml) sets `uniquelocal`, because a proxy on the host reaches the container from the Docker bridge (a private address); override it in `.env`. The proxy must set `X-Forwarded-For` itself (Caddy and Traefik do; in nginx, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Do not expose the container port directly to the internet alongside the proxy, or anyone could choose their own address.
- Limit sign-in at the proxy as well: the app's counters live in one process and cannot see a flood before it arrives. For example, in nginx `limit_req_zone $binary_remote_addr zone=signin:10m rate=10r/m;` with `limit_req zone=signin burst=10 nodelay;` on `location = /id/authorize` (POST) and `/id/token`; in Caddy, a rate-limit plugin or your platform's WAF.
- Set `TRUST_PROXY` for the MCP rate limit too (below): without it every client behind the proxy shares one count.
- Keep Connect tokens out of access logs. A Connect link carries its token in the path (`/libraries/<id>/mcp/<token>`). Either connect clients that can set headers to `/libraries/<id>/mcp` with `X-Library-Token: <token>`, or drop the path from proxy logs, e.g. in nginx `map $request_uri $loggable { ~^/libraries/[^/]+/mcp/ 0; default 1; }` with `access_log … if=$loggable;`, or log a rewritten `$uri` with the last segment removed. The same applies to the RFC 9728 metadata path `/.well-known/oauth-protected-resource/libraries/<id>/mcp/<token>`.
- Libraries created before migration 007 had md5-derived Connect tokens. Migration 015 replaces them once with random ones; agents using one of those old links must copy the new link from **Connect**.
- Keep Postgres off the public internet. If it is remote, use `POSTGRES_SSL=required`.

## MCP rate limit

Both library MCP routes, the Connect link (`/libraries/<id>/mcp/<token>`) and the `X-Library-Token` form (`/libraries/<id>/mcp`), share one limit of `MCP_RATE_LIMIT_PER_MINUTE` requests per client address per minute (default 300). Every MCP message is one request, so 300 is several busy agents' worth from one address; raise it if many agents share an address (a NAT, a kiosk host), or set `0` to turn it off and limit at the proxy instead.

- The client address is Express's `req.ip`, so it follows `TRUST_PROXY`. Off (the default), it is the socket peer and `X-Forwarded-For` is ignored, so a client cannot pick a fresh address per request. Behind a trusted proxy it is the browser or agent's address from `X-Forwarded-For`. IPv6 clients are counted per /56; IPv4-mapped IPv6 addresses count as their IPv4 address.
- Responses carry the IETF `RateLimit-Policy` and `RateLimit` headers (draft 8). Over the limit the app answers `429` with `Retry-After` and a JSON-RPC error body: `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Too many requests …"},"id":null}`.
- CORS preflights (`OPTIONS`) are not counted.
- Counts live in memory in one process and reset on restart. With several app replicas, each counts on its own; limit at the proxy or load balancer as well.

## Postgres version

PostgreSQL 16 is the documented version (Compose and CI use it). The app and test suite have also been verified on PostgreSQL 17.
