# Deploy

MCPEncode ships as a container image built from the [`Dockerfile`](../Dockerfile). It runs on any host that runs containers (a VM with Docker Compose, Kubernetes, or a container platform) next to a PostgreSQL database. There is nothing provider-specific in the app: all configuration comes from the environment variables below.

> **Every public deploy must set `SETUP_TOKEN`.** On a non-local address the first visitor creates the first account (an SA). Without `SETUP_TOKEN` the page falls back to a one-time code printed in the server log, which anyone with log access can read. `scripts/init-env.sh` generates one in `.env` (and adds one to an existing `.env` that has none, without touching other values). Otherwise set a 16+ character value (`openssl rand -base64 18`) before the app is reachable, and keep it secret.

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
| `SETUP_TOKEN` | yes (public) | Code needed to create the first account. 16+ characters. |
| `PORT` | no | Listen port. Default 3000. |
| `BIND_HOST` | no | Listen address. Default `127.0.0.1`; the image sets `0.0.0.0`. |
| `DATABASE_URL` | one of | `postgresql://user:password@host:port/database[?sslmode=require]` |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | one of | Separate settings. They override the matching part of `DATABASE_URL`. Standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` also work. |
| `POSTGRES_SSL` | for a remote database | `required` (verify TLS, preferred) or `disable` (trusted private network only). Not needed for `127.0.0.1`. |
| `ALLOWED_HOSTS` | no | Extra hostnames (comma-separated) beyond the one in `PUBLIC_BASE_URL`, e.g. `www.` |
| `OAUTH_REDIRECT_HOSTS` | no | Pin remote MCP client callbacks to these hostnames. |

The database role needs to own its database (it creates tables on migration). It does not need `CREATEDB`.

## Health check

`GET /healthz` needs no auth and is answered before the Host check, so platform probes with an internal Host header work.

- `200 {"status":"ok","database":"ok"}` when Postgres answers.
- `503 {"status":"unavailable","database":"unreachable"}` when it does not (3 second limit). The reason is logged, not returned.

The image has a Docker `HEALTHCHECK` on it. Point your load balancer or orchestrator readiness probe at `/healthz`.

## TLS and reverse proxy

The built-in sign-in sends passwords and session cookies, so a public address must use HTTPS. Terminate TLS in a reverse proxy (Caddy, nginx, Traefik, or your platform's load balancer) and forward to the container:

- Set `PUBLIC_BASE_URL` to the `https://` address. The Host header the proxy forwards must match that hostname (or one in `ALLOWED_HOSTS`); other hosts get 403.
- With a non-loopback bind the app trusts one proxy hop for the client address (`X-Forwarded-For`), which the sign-in rate limit uses. Do not expose the container port directly to the internet alongside the proxy.
- Keep Postgres off the public internet. If it is remote, use `POSTGRES_SSL=required`.

## Postgres version

PostgreSQL 16 is the documented version (Compose and CI use it). The app and test suite have also been verified on PostgreSQL 17.
