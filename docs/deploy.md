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
| `SETUP_TOKEN` | yes | Code needed to create the first account. 16+ characters. **Always set it on a public deploy.** Without it a one-time code is printed to the log, readable by anyone with log access, and a new one is generated on every restart until the first account exists. |
| `ALLOW_OPEN_SETUP` | no | `true` lets the first visitor create the SA with no code. Default `false`. Local throwaway instances only. |
| `TRUST_PROXY` | behind a proxy | Which proxies may set the client address (`X-Forwarded-For`) for the sign-in throttle. Default off (the socket peer is the client). A hop count (`1`) or a list of addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`. `true` is refused. Compose sets `uniquelocal`. See [TLS and reverse proxy](#tls-and-reverse-proxy). |
| `PASSWORD_HASH_CONCURRENCY` | no | scrypt hashes run at once (64 MiB each). Default 2, 1–16. |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | Library MCP requests (`/libraries/<id>/mcp` and `/libraries/<id>/mcp/<token>`) per client address per minute. Default 300, 0 turns it off, at most 100000. The address follows `TRUST_PROXY`. See [MCP rate limit](#mcp-rate-limit). |
| `AUTH_MCP_AUDIENCE` | oidc mode | The audience library MCP tokens must carry, separate from `AUTH_AUDIENCE` (web sign-in). **Required with `AUTH_MODE=oidc`**: startup fails without it. Ignored with built-in sign-in, where each library link is its own audience. |
| `AUTH_MCP_AUDIENCE_SHARED` | no | `true` lets an oidc deploy start without `AUTH_MCP_AUDIENCE` and reuse `AUTH_AUDIENCE` for MCP (the old behaviour, with a startup warning). Default `false`. Compatibility only. |
| `ALLOW_INSECURE_HTTP` | no | `true` lets `PUBLIC_BASE_URL` be plain `http://` on a non-loopback host. Default `false`: startup fails, because passwords, cookies and sign-in codes would travel unencrypted. `http://127.0.0.1`, `http://localhost` and `http://[::1]` always work. |
| `PORT` | no | Listen port. Default 3000. |
| `BIND_HOST` | no | Listen address. Default `127.0.0.1`; the image sets `0.0.0.0`. |
| `DATABASE_URL` | one of | `postgresql://user:password@host:port/database[?sslmode=require]` |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | one of | Separate settings. They override the matching part of `DATABASE_URL`. Standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` also work. |
| `POSTGRES_CONNECT_TIMEOUT_SECONDS` | no | How long startup keeps retrying while Postgres is unreachable. Default 60; `0` tries once. See [Startup and the database](#startup-and-the-database). |
| `POSTGRES_SSL` | for a remote database | `required` (verify TLS, preferred) or `disable` (trusted private network only). Not needed for `127.0.0.1`. |
| `ALLOWED_HOSTS` | no | Extra hostnames (comma-separated) beyond the one in `PUBLIC_BASE_URL`, e.g. `www.` |
| `OAUTH_REDIRECT_HOSTS` | no | Remote `https` hostnames (comma-separated) an MCP client may use as its sign-in callback, e.g. `claude.ai`. Loopback and app-scheme callbacks need no entry. See [MCP client sign-in](#mcp-client-sign-in). |
| `OAUTH_ALLOW_ANY_HTTPS_REDIRECT` | no | `true` accepts a callback on any `https` host. Default `false`. Only for a deploy where everyone who can sign in is trusted to judge the consent page. |
| `OAUTH_ALLOWED_SCHEMES` | no | Extra single-word app callback schemes (comma-separated, e.g. `windsurf`), added to the built-in `cursor`, `vscode`, `vscode-insiders`, `claude`. Reverse-DNS schemes with a dot need no entry. Browser-launcher and OS-handler schemes are refused even if listed. |
| `OAUTH_LEGACY_CLIENT` | no | Default `true`: the old shared client id `mpos-mcp` still signs in, now only with loopback callbacks, the known app schemes above (`cursor:` etc.) and `OAUTH_REDIRECT_HOSTS`. Never reverse-DNS schemes. Set `false` once every client has reconnected. |
| `OAUTH_REGISTER_RATE_LIMIT` | no | Client registrations (`POST /id/register`) per address per hour. Default 20; `0` turns it off. |
| `OAUTH_AUTHORIZE_RATE_LIMIT` | no | `/id/authorize` requests (page and form) per address per minute. Default 60; `0` turns it off. |
| `OAUTH_MAX_PENDING_CLIENTS` | no | Registrations not yet used for a sign-in that are kept at once, across all addresses (they expire after `OAUTH_PENDING_CLIENT_TTL_MINUTES` and are swept hourly and on each registration). Default 1000. Past it, `/id/register` answers 503 until some expire. |
| `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS` | no | Unused registrations one client address may hold at once (IPv6 counted per /64, like the sign-in throttle). Default 20, 1 to 1000000. Past it, `/id/register` answers 429 with `Retry-After` until one is used for a sign-in or expires. A registration counts as used once it completes a sign-in. The address follows `TRUST_PROXY`. |
| `OAUTH_PENDING_CLIENT_TTL_MINUTES` | no | How long a registration that never completed a sign-in is kept. Default 60 (one hour; earlier releases kept them 24 hours), 5 to 10080. Registrations that have signed in are kept while their tokens live. |
| `OAUTH_REFRESH_MAX_DAYS` | no | A sign-in's refresh tokens stop working this many days after sign-in, however often they are used. Default 30, 1–365. |

The database role needs to own its database (it creates tables on migration). It does not need `CREATEDB`.

## MCP client sign-in

With built-in sign-in, each MCP client registers itself (`/id/register`) and gets its own client id, tied to the callbacks it registered. After the password, the person sees a consent page naming the client, the host the sign-in is sent to, and the library, and chooses **Allow** or **Deny**.

Which callbacks a client may register:

| Callback | Accepted | Typical clients |
| --- | --- | --- |
| `http://127.0.0.1:<port>/…`, `http://[::1]:<port>/…`, `http://localhost:<port>/…` | always | Claude Code, Claude Desktop via `mcp-remote`, MCP Inspector, VS Code, Cursor |
| Reverse-DNS app scheme with a dot, e.g. `com.example.app:/…` (RFC 8252 §7.1) | always | native apps |
| Known single-word app scheme: `cursor:`, `vscode:`, `vscode-insiders:`, `claude:`, plus `OAUTH_ALLOWED_SCHEMES` | always | Cursor, VS Code, Claude |
| Browser launchers and OS handlers: `microsoft-edge:`, `x-safari-*`, `googlechrome(s):`, `firefox:`, `opera*`, `brave:`, `ms-*`, `search-ms:`, `shell:`, `file:`, `data:`, `javascript:`, `vbscript:`, … | never | |
| Any app scheme whose path holds another URL (`foo:https://…`) | never | |
| `https://<host>/…` | only if `<host>` is in `OAUTH_REDIRECT_HOSTS`, or `OAUTH_ALLOW_ANY_HTTPS_REDIRECT=true` | Claude custom connectors (`claude.ai`), Perplexity (`www.perplexity.ai`) |
| `http://<remote host>/…` | never | |

These are the native-app rules of RFC 8252: a loopback or app-scheme callback can only be received on the person's own machine. Browser-launcher schemes are the exception that breaks this (they open a web page at an address the client picked, carrying the code), so they are refused. An app scheme is still only as trustworthy as whichever app on the person's machine claimed it: **the consent page is the guard.** It shows the full callback address, the client id, and the client's self-declared name marked as unverified; people should allow only a sign-in they started from an app they trust. A remote `https` callback could belong to anyone, which is why it is opt-in per host. A loopback IP callback may come back on a different port than it registered (RFC 8252 §7.3); everything else must match exactly.

**Upgrading to this release (v0.1 hardening) — breaking changes:**

- `AUTH_MODE=oidc` deploys must set `AUTH_MCP_AUDIENCE` (or `AUTH_MCP_AUDIENCE_SHARED=true` to keep the old shared audience); otherwise the app refuses to start.
- A non-loopback `http://` `PUBLIC_BASE_URL` refuses to start; use `https://` behind a TLS proxy, or set `ALLOW_INSECURE_HTTP=true` deliberately.
- Clients registered with a browser-launcher scheme or an unknown single-word scheme can no longer sign in; they must use loopback, a reverse-DNS scheme, or a scheme added to `OAUTH_ALLOWED_SCHEMES`. Cursor, VS Code, Claude Code, Claude Desktop (`mcp-remote`) and MCP Inspector are unaffected.
- The shared legacy id `mpos-mcp` no longer accepts reverse-DNS app schemes (loopback, `cursor:`/`vscode:`/`vscode-insiders:`/`claude:` and listed hosts still work). Reconnecting the client registers its own id.
- `/id/register` takes at most 8 callbacks and 8 KB, and is rate limited; `/id/authorize` is rate limited (see the table above).

**Upgrading from a release before client registration was stored:** every client used the fixed id `mpos-mcp` and any callback was accepted. After the upgrade:

- Everyone signs in once more (refresh tokens used to live in memory, and the signing key is new).
- Clients on loopback or app-scheme callbacks keep working with `mpos-mcp` while `OAUTH_LEGACY_CLIENT` is on (the default), now with the consent page. Reconnecting a client makes it register its own id.
- A client on a remote `https` callback stops working until its host is in `OAUTH_REDIRECT_HOSTS`; then reconnect it.

### Sign-in lifetime

Access tokens last 15 minutes. Refresh tokens rotate on every use and are stored hashed in Postgres, so a restart or a redeploy keeps people signed in. A refresh token not used for 12 hours expires, and a sign-in ends `OAUTH_REFRESH_MAX_DAYS` (default 30) after it started. If a refresh token that was already used comes back, the whole sign-in is revoked: either the client or someone who copied the token holds it, and both must sign in again.

Sign-out and an SA password reset sign that account out everywhere: other browser sessions, MCP access tokens and refresh tokens.

The token signing key is stored in Postgres, encrypted with a key derived from `SESSION_SECRET`. **Changing `SESSION_SECRET` rotates the signing key too:** the old key can no longer be decrypted, a new one is made, and every browser session, MCP access token and refresh token stops working, so everyone signs in again. Plan a rotation like a forced sign-out.

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
- Set `TRUST_PROXY` so the sign-in throttle sees the browser's address, not the proxy's. **Prefer `TRUST_PROXY=1` behind a single reverse proxy**, including intranet deploys: it trusts exactly one hop, whatever the proxy's address. It is off by default: without it every visitor shares the proxy's address. `1` trusts one hop; a list (`127.0.0.1`, `10.0.0.0/8`, `loopback,uniquelocal`) trusts only proxies at those addresses, which is safer. [`docker-compose.yml`](../docker-compose.yml) sets `uniquelocal`, because a proxy on the host reaches the container from the Docker bridge (a private address); override it in `.env`. The proxy must set `X-Forwarded-For` itself (Caddy and Traefik do; in nginx, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Do not expose the container port directly to the internet alongside the proxy, or anyone could choose their own address.
- **A wrong `TRUST_PROXY` behind a proxy makes every visitor share one address** (the proxy's). Then the per-address budgets become global: `OAUTH_REGISTER_RATE_LIMIT`, `OAUTH_AUTHORIZE_RATE_LIMIT`, `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS`, `MCP_RATE_LIMIT_PER_MINUTE` and the sign-in throttle are spent by everyone together, so one noisy client can lock everybody out of registering or signing in. When `TRUST_PROXY` is unset and a request arrives with `X-Forwarded-For`, the app logs one warning saying so. Set it, restart, and the warning stops.
- Limit sign-in at the proxy as well: the app's counters live in one process and cannot see a flood before it arrives. For example, in nginx `limit_req_zone $binary_remote_addr zone=signin:10m rate=10r/m;` with `limit_req zone=signin burst=10 nodelay;` on `location = /id/authorize` (POST) and `/id/token`; in Caddy, a rate-limit plugin or your platform's WAF.
- The sign-in throttle remembers, for 30 days, each address a username signed in from successfully (IPv6 per /64), so a distributed password guess cannot keep the SA out of their usual place. These are kept in Postgres (table `signin_known_good`, migration 016) as a SHA-256 of username + address, never in the clear, capped at 10,000 rows, and survive a restart.
- Set `TRUST_PROXY` for the MCP rate limit too (below): without it every client behind the proxy shares one count.
- Rotating a Connect link (**Connect → Rotate**) invalidates the old token in both forms at once: the path form and the `X-Library-Token` header value are the same token, checked against the library on every request. An agent using the header must be given the new value.
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
