# Contributing

Thanks for your interest. MCPEncode is early (0.1), so a little coordination goes a long way. AI coding agents: start with [AGENTS.md](AGENTS.md).

## Before you start

- **Bugs:** open an issue with steps to reproduce.
- **Features or larger changes:** open an issue first so we can agree on the approach before you write code.
- **Security problems:** do not open an issue — see [SECURITY.md](SECURITY.md).

## Development setup

Requires Node 22+ and Docker (or your own PostgreSQL 16+; see [docs/develop.md](docs/develop.md) for the `CREATEDB` note on tests).

```bash
scripts/init-env.sh            # creates .env with random secrets
docker compose up -d postgres
npm install
npm start
```

Before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
```

Product vocabulary (Library, Item, Publish, Connect link, Reader, Publisher, Site admin, Review Lock) is defined in [docs/concepts.md](docs/concepts.md). Please use those words in code, UI text and docs.

## Privacy and secrets

- **Never commit secrets.** `.env`, keys, tokens and `.cursor/mcp.json` are git-ignored; keep it that way. CI runs a secret scan on every pull request.
- **Use example data only** in tests, fixtures and screenshots — no real organization names, hostnames, IPs or people.
- **Keep your email private:** commit with your GitHub no-reply address (`ID+username@users.noreply.github.com`, shown under GitHub → Settings → Emails).

## Licensing

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
