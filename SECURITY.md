# Security policy

MCPEncode stores the facts an organization trusts its agents with, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Include:

- what an attacker can do, and what they need first (an account, a Reader key, network access);
- steps to reproduce, or a proof of concept;
- the version or commit you tested.

You can expect an acknowledgement within 7 days. This is a spare-time project, so a fix may take longer; you'll be kept informed, and credited in the advisory unless you'd rather not be.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` / latest `0.x` release | Yes |
| Older releases | No |

## Scope

In scope: the publisher web app, the MCP server, authentication and access control, the publish gate, Reader keys, and anything that lets an agent read unpublished items, write without permission, or reach another library.

Out of scope: running with the example or placeholder secrets, exposing the built-in sign-in to the internet without TLS, and issues in third-party services (Postgres, your MCP client) — report those upstream.

## Deployment hardening

- Run `scripts/init-env.sh` to generate secrets. The app refuses to start with a placeholder `SESSION_SECRET`.
- The default bind is `127.0.0.1`. Put MCPEncode behind a TLS-terminating reverse proxy before exposing it, and set `PUBLIC_BASE_URL` to the `https://` origin.
- Responses carry a Content-Security-Policy (no framing, no third-party loads), `nosniff`, and HSTS on HTTPS. Session cookies are `Secure` on an HTTPS address. Password hashes use scrypt at 64 MiB per hash and older hashes are upgraded at sign-in.
- On a public address, the first account needs a setup code. **Every public deploy should set `SETUP_TOKEN`** (16+ characters) before it is reachable; otherwise a one-time code is printed to the server log at first start. See [docs/deploy.md](docs/deploy.md).
- If you only connect known clients, set `OAUTH_REDIRECT_HOSTS` to their hostnames (for example `claude.ai`).
- Remote Postgres must use `POSTGRES_SSL=required`.
- Treat each library's Connect link and Reader key as secrets. Rotate them from the publisher UI if they leak.
