<p align="center">
  <img src="docs/assets/landing.png" alt="MCPEncode — libraries of items you publish for people and agents" width="920" />
</p>

# MCPEncode

**Libraries of items you publish for people and agents.**

Keep the business facts your org actually trusts — policies, procedures, runbooks, rosters — in libraries. People publish. Agents look them up. No inventing when the answer is not there.

| | |
| --- | --- |
| **Library** | What you publish (its own Connect link and Access list) |
| **Item** | One thing in a library — name, labels, summary, sections |
| **Publish** | The gate. Readers and agents only see what you Publish |

---

## How it works

1. **Add items** in a library (or let an agent draft them).
2. **Publish** when the content is ready — or use Review Unlock if saves should go live immediately.
3. **Look up** from Cursor, a kiosk, or any MCP client with that library’s Connect link.

<p align="center">
  <img src="docs/assets/publisher.png" alt="Publisher — library of published items with Connect and Review Lock" width="920" />
</p>

<p align="center">
  <img src="docs/assets/item.png" alt="Published item — Remote access policy with details and status" width="920" />
</p>

---

## Why it exists

Most “AI knowledge” piles are a dump. Agents hallucinate into the gaps. MCPEncode is the opposite:

- **Auth is to a library** — not one global pile
- **Publish is human** — agents can draft; people decide what is live
- **Lookup cites an item** — or says it is not in the library
- **Revert to published** — undo a bad overwrite from the last published snapshot

---

## Quick start

```bash
git clone https://github.com/hkrlogic/MCPEncode.git
cd MCPEncode
cp .env.example .env
docker compose up -d postgres
npm install
npm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/). The first visit creates your account. Add a library, add an item, Publish.

### Connect Cursor

Open a library → **Connect** → copy the MCP link into `.cursor/mcp.json`. Sign in when Cursor prompts. That connection is scoped to that library only.

> Use `127.0.0.1`, not `localhost` — they are different OAuth audiences.

---

## Concepts

| Idea | Meaning |
| --- | --- |
| **Review Lock** | Create/update stays Pending until a human Publishes (default) |
| **Review Unlock** | Successful saves are Published immediately |
| **Connect** | Per-library MCP URL with a secret path segment (rotate if it leaks) |
| **Access** | Per-library **Publisher** / **Reader** grants |
| **SA** | App admin — Accounts, add libraries, hard-delete |

Lookups over MCP: `list_items`, `open_item`. There is no publish tool and no revert tool — those stay in the publisher UI.

---

## Stack

Node 22 · Express · PostgreSQL · OAuth 2.1 + PKCE · MCP

Sign-in is built in. Optional external IdP via `AUTH_MODE=oidc` (Zitadel bootstrap included).

```bash
npm test
```

---

## Docs

| Doc | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Product vocabulary and status gate |
| [docs/develop.md](docs/develop.md) | Run details, security notes, layout |
| [docs/library-schema-v1.md](docs/library-schema-v1.md) | Starters, propose field, copy/rename |
| [docs/revert-to-published.md](docs/revert-to-published.md) | Overwrite recovery |

---

## License

Source available for now — choose a public license when you cut the fresh public repo.
