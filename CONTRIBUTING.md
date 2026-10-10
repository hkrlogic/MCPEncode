# Contributing

Thanks for your interest. MCPEncode is maintained in spare time, so a little coordination goes a long way.

## Before you start

- **Bugs:** open an issue with steps to reproduce.
- **Features or larger changes:** open an issue first so we can agree on the approach before you write code.
- **Security problems:** do not open an issue — see [SECURITY.md](SECURITY.md).

## Development setup

Requires Node 22+ and Docker.

```bash
scripts/init-env.sh            # creates .env with random secrets
docker compose up -d postgres
npm install
npm start
```

Before opening a pull request:

```bash
npm run typecheck
npm test
```

Product vocabulary (Library, Item, Publish, Review Lock) is defined in [AGENTS.md](AGENTS.md). Please use those words in code, UI text and docs.

## Privacy and secrets

- **Never commit secrets.** `.env`, keys, tokens and `.cursor/mcp.json` are git-ignored; keep it that way. CI runs a secret scan on every pull request.
- **Use example data only** in tests, fixtures and screenshots — no real organization names, hostnames, IPs or people.
- **Keep your email private:** commit with your GitHub no-reply address (`ID+username@users.noreply.github.com`, shown under GitHub → Settings → Emails).

## Licensing

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
