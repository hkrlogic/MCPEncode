# Changelog

## v0.1.0

First tagged release.

### Breaking changes

- **Fewer settings.** These environment variables were removed. If one is still set, the app starts, ignores it and logs one line naming it:
  - `OAUTH_LEGACY_CLIENT`: the shared legacy client id is gone (below).
  - `OAUTH_REGISTER_RATE_LIMIT` (20/hour), `OAUTH_AUTHORIZE_RATE_LIMIT` (60/minute), `OAUTH_MAX_PENDING_CLIENTS` (1000), `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS` (20), `OAUTH_PENDING_CLIENT_TTL_MINUTES` (60), `PASSWORD_HASH_CONCURRENCY` (2), `OAUTH_REFRESH_MAX_DAYS` (30): now fixed at the value shown, which was the default.
  - `OAUTH_ALLOWED_SCHEMES`, `OAUTH_ALLOW_ANY_HTTPS_REDIRECT`: callbacks are loopback, reverse-DNS app schemes, `cursor`/`vscode`/`vscode-insiders`/`claude`, or an `https` host listed in `OAUTH_REDIRECT_HOSTS`.
  - `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL`: `ALLOW_INSECURE_HTTP` covers it.
  - `AUTH_MCP_AUDIENCE_SHARED`: with `AUTH_MODE=oidc`, `AUTH_MCP_AUDIENCE` is always required.
  - `ALLOW_OPEN_SETUP`: the first account always needs the setup code.
- **The shared legacy client id is gone.** Every MCP client registers its own client id. A client still using the shared legacy client id gets `unknown client_id`; reconnecting it registers a new id. Cursor, VS Code, Claude Code, Claude Desktop (`mcp-remote`) and MCP Inspector register on their own.
- **`AUTH_MODE=oidc` requires `AUTH_MCP_AUDIENCE`.** Set the audience your identity provider puts in MCP access tokens; without it the app refuses to start ([docs/oidc.md](docs/oidc.md)).
- **`http://` `PUBLIC_BASE_URL` on a non-loopback host refuses to start.** Use `https://` behind a TLS proxy, or set `ALLOW_INSECURE_HTTP=true` deliberately.
- **Single-word callback schemes are refused** unless they are `cursor`, `vscode`, `vscode-insiders` or `claude`. Browser-launcher schemes are always refused. Remote `https` callbacks (hosted clients such as claude.ai or LibreChat) need their host in `OAUTH_REDIRECT_HOSTS`.
- **Unused client registrations expire after 1 hour** (was 24 hours), and one address may hold at most 20 of them.
- **New names.** Cookies are now `mcpencode_*`, so everyone signs in once more after the upgrade. Built-in sign-in tokens carry `mcpencode:*` scopes (older tokens keep working). The default web client id is `mcpencode-web`: with `AUTH_MODE=oidc`, set `WEB_CLIENT_ID` to the client id registered at your issuer. The default database user and name are `mcpencode`: an existing `.env` keeps its `POSTGRES_USER` and `POSTGRES_DATABASE` lines, but if yours has none and you relied on the old defaults, add `POSTGRES_USER=mpos` and `POSTGRES_DATABASE=mpos`.

### Security

- `/id/register` and `/id/authorize` are rate limited per address; `/id/register` takes at most 8 callbacks and 8 KB.
- Per-address cap on pending dynamic client registrations (IPv6 per /64), alongside the global cap.
- Known-good sign-in addresses (the sign-in throttle bypass) are kept in Postgres, hashed, so they survive a restart (migration 016).
- One warning is logged when a request carries `X-Forwarded-For` but `TRUST_PROXY` is not set: behind a proxy, all clients would share one address for rate limits.

### Setup and docs

- `scripts/init-env.sh` fills every missing secret (`SESSION_SECRET`, `SETUP_TOKEN`, `POSTGRES_PASSWORD`) and never changes a set value. `.env.example` is down to the lines people change.
- `npm run check-env` validates a `.env` and lists missing, removed and unknown settings. `src/env-schema.ts` lists every setting; docs/deploy.md has the same table.
- `AGENTS.md` is the guide for AI coding agents (deploy, verify, fix, test); `llms.txt` indexes the docs. New: docs/concepts.md, docs/oidc.md, docs/known-limitations.md.

### Known limitations

See [docs/known-limitations.md](docs/known-limitations.md): single instance only, Connect tokens stored in plain text (hashing planned for v0.2), Review Lock hides edited items until published again (fix planned for v0.2).
