<p align="center">
  <img src="docs/assets/landing.png" alt="MCPEncode — libraries of items you publish for people and agents" width="920" />
</p>

# MCPEncode

**Trusted, human-approved context for AI agents — served over MCP.**

Your agents need facts they can rely on: the current policy, the real recovery steps, the approved vendor list. Most "AI knowledge" is a pile of documents where nobody can tell an approved procedure from an old draft, and agents fill the gaps by guessing.

MCPEncode keeps that knowledge in **libraries** with a shape you define. Agents can look things up and draft changes. **Only a person can Publish.** Agents only ever read what was published, and they cite an item or say it isn't there.

---

## How it works

1. **Add a library** — a policy, a procedure, or a table you design (e.g. CIS controls, DR scenarios, a vendor register).
2. **Connect an agent** with that library's MCP link. The library's fields become the tool's parameters, so the agent can't invent columns.
3. **The agent drafts** — from an interview, a scan, or a sync. Drafts wait in **Pending**.
4. **A person Publishes.** Now readers and agents see it. Every change is in the audit log, and Revert brings back the last published copy.
5. **Put libraries on a shelf** to search across them; the agent opens the item from the library that owns it before citing it.

<p align="center">
  <img src="docs/assets/publisher.png" alt="Publisher — library of published items with Connect and Review Lock" width="920" />
</p>

---

## Why it's different

| | Typical RAG / wiki over MCP | MCPEncode |
| --- | --- | --- |
| What the agent reads | Whatever is in the pile | Only published items |
| Who decides what's true | Whoever edited last | A person, at Publish |
| Shape | Free text | Your schema, enforced on every write |
| Schema changes | Anyone, anytime | Agent proposes a field; a person approves |
| Scope of access | Often everything | One library per Connect link, per-library Access |
| Tool output | Raw text | Labelled as data, not instructions |

---

## Quick start

Requires Node 22+ and Docker.

```bash
git clone https://github.com/hkrlogic/MCPEncode.git
cd MCPEncode
scripts/init-env.sh         # creates .env with fresh random secrets
docker compose up -d postgres
npm install
npm start
```

Open <http://127.0.0.1:3000/>. The first visit creates your account. Add a library, add an item, Publish.

### Connect an MCP client

Open a library → **Connect** → copy the MCP link into your client (Cursor, Claude, LibreChat, …). Sign in when prompted. That connection sees one library only.

> Use `127.0.0.1`, not `localhost` — they are different OAuth audiences.

For a shared agent that only reads, create a **Reader key** on the library and send it as `Authorization: Bearer <key>`.

---

## MCP tools

| Tool | Does |
| --- | --- |
| `list_items` | Look up by question or name. One clear match returns the full item. |
| `open_item` | Full item by id |
| `search_shelf` | Search published items across the library's shelf (summaries only) |
| `create_item` / `update_item` | Save a draft (Review Lock) or publish directly (Review Unlock) |
| `delete_item` | Remove an item |
| `create_library` / `propose_table` / `propose_field` | Design a library; a person approves the schema |
| `list_audit` | Who called which tool |
| `whoami` | Current identity and role |

There is **no publish, approve or revert tool.** Those stay with people in the publisher UI.

---

## Concepts

| Idea | Meaning |
| --- | --- |
| **Library** | A set of items with one schema, one Connect link, one Access list |
| **Item** | One entry — name, labels, summary, fields |
| **Shelf** | A group of libraries searched together |
| **Review Lock** | Writes stay Pending until a person Publishes (default) |
| **Review Unlock** | Writes publish immediately — for automation output |
| **Entity key** | Stable id (e.g. a hostname) so repeated syncs update one item |
| **Access** | Per-library Publisher / Reader grants |
| **SA** | App admin — accounts, add libraries, hard-delete |

---

## Security

- Secrets are generated per install by `scripts/init-env.sh`; the app refuses to start with a placeholder `SESSION_SECRET`.
- Default bind is `127.0.0.1`. The built-in sign-in is meant for local and small-team use — **put MCPEncode behind TLS and set real secrets before exposing it.** Use `AUTH_MODE=oidc` for an external identity provider (Zitadel bootstrap included).
- Disabling or demoting an account takes effect immediately: sessions, tokens and refreshes are re-checked on every request.
- On a public address, creating the first account takes a setup code, so a stranger cannot claim a new instance.
- The sign-in page shows where you will be sent. Tokens can only be requested for this app's own libraries, and `OAUTH_REDIRECT_HOSTS` can pin callbacks to known hostnames.
- Tokens are checked for signature, issuer, expiry and audience. Access tokens are never stored.
- Reader keys are stored as SHA-256 hashes and can only read published items.
- Item Markdown never executes raw HTML. Forms carry CSRF; sessions are httpOnly cookies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

---

## Stack

Node 22 · Express · PostgreSQL · OAuth 2.1 + PKCE · MCP

```bash
npm test
npm run typecheck
```

## Docs

| Doc | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Product vocabulary and the status gate |
| [docs/develop.md](docs/develop.md) | Run details, security notes, layout |
| [docs/library-schema-v1.md](docs/library-schema-v1.md) | Starters, propose field, copy/rename |
| [docs/revert-to-published.md](docs/revert-to-published.md) | Overwrite recovery |

## Status

Early (0.1). Maintained in spare time. Issues are welcome; please open one before a large pull request.


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately — see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
