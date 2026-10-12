# Changelog

## v0.1.0

First tagged release.

### Breaking changes

- **`AUTH_MODE=oidc` requires `AUTH_MCP_AUDIENCE`.** Set the audience your identity provider puts in MCP access tokens, or set `AUTH_MCP_AUDIENCE_SHARED=true` to keep the old shared audience. Without either, the app refuses to start.
- **`http://` `PUBLIC_BASE_URL` on a non-loopback host refuses to start.** Use `https://` behind a TLS proxy, or set `ALLOW_INSECURE_HTTP=true` deliberately.
- **Single-word callback schemes are refused.** OAuth callbacks must be loopback (`http://127.0.0.1`, `http://[::1]`, `http://localhost`), a reverse-DNS app scheme (`com.example.app:/callback`), or one of the known app schemes `cursor`, `vscode`, `vscode-insiders`, `claude`. Add other schemes with `OAUTH_ALLOWED_SCHEMES`. Browser-launcher schemes are always refused. Remote `https` callbacks (hosted clients such as LibreChat) need their host in `OAUTH_REDIRECT_HOSTS`.
- **Legacy clients reconnect.** The shared legacy client id `mpos-mcp` no longer accepts reverse-DNS app schemes; clients registered with a now-refused scheme cannot sign in. Reconnecting the client registers its own client id. Cursor, VS Code, Claude Code, Claude Desktop (`mcp-remote`) and MCP Inspector are unaffected.
- **Unused client registrations expire after 1 hour** (was 24 hours), and one address may hold at most 20 of them. See `OAUTH_PENDING_CLIENT_TTL_MINUTES` and `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS`.

### Security

- `/id/register` and `/id/authorize` are rate limited per address; `/id/register` takes at most 8 callbacks and 8 KB.
- Per-address cap on pending dynamic client registrations (IPv6 per /64), alongside the global `OAUTH_MAX_PENDING_CLIENTS`.
- Known-good sign-in addresses (the sign-in throttle bypass) are kept in Postgres, hashed, so they survive a restart (migration 016).
- One warning is logged when a request carries `X-Forwarded-For` but `TRUST_PROXY` is not set: behind a proxy, all clients would share one address for rate limits.

### New settings

| Variable | Default |
|----------|---------|
| `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS` | `20` |
| `OAUTH_PENDING_CLIENT_TTL_MINUTES` | `60` |

### Known limitations

See [README.md](README.md#known-limitations-v01): single instance only, Connect tokens stored in plain text (hashing planned for v0.2), Review Lock hides edited items until published again (fix planned for v0.2).
