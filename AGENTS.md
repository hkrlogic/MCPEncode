# MCPEncode

Publisher for organization libraries. Open this folder (`~/MCPEncode`) for publisher work — not the kiosk workspace.

GitHub: `hkrlogic/MCPEncode`.

## Product

You keep **libraries** of **items**. Auth is to a library. Each item has a **name**, **labels**, a **summary**, and **sections** (for now: markdown **body** plus policy/procedure templates). **Publish** items in a library so people and agents can look them up.

| Word | Meaning |
| --- | --- |
| **Library** | What someone publishes (hosted MCP). Many libraries, not one global pile. |
| **Item** | One thing in a library. |
| **Section** | Typed chunk on an item (Table, Checklist, Details, Description) — body-shaped for now. |
| **Publisher** | This app. |
| **Kiosk** | Separate chat UI in `~/organization-chat/ollama-mcp-chat`. |

**MCP** is plumbing (Cursor, kiosk, Perplexity, etc.). Do not invent synonyms (vault, notebook, portal).

## Status gate

Items: `draft` → `published` (optional `archived`). Readonly MCP only sees published.

Each library has a **write mode**:
- **Review Lock** (default) — create/update save as Pending; a human Publishes. Stored value: `reviewed`.
- **Review Unlock** — successful create/update is Published immediately. Stored value: `direct`.

Choose the mode when adding a library. Publishers can change it later in the UI only (not over MCP).

Review Unlock MCP connections include handoff instructions: prefer `entity_key` for upserts, search before create, one item per entity, stable name, searchable summary, useful labels, then the next agent scoops with `list_items` / `open_item`.

## Run

```bash
cd ~/MCPEncode
docker compose up -d postgres
npm start
```

Sign-in is built in. The first browser visit creates the account (no demo passwords). `AUTH_MODE=oidc` is an optional external identity provider.

Open `http://127.0.0.1:3000/`. Each library has its own MCP link under **Connect** (includes a secret path segment). Rotate that link under Actions if it leaks — Access grants stay. Remove on Access drops one person. The global `/mcp` URL is retired.

## Access

**SA** (app role) manages accounts, adds libraries, opens every library, and hard-deletes items. **Publisher** / **Reader** are per-library. Publishers archive items and may delete their library; only SA hard-deletes items. With built-in sign-in, grant Access by username. Agents connect with that library’s Connect link only.

## Related

Kiosk workspace: `~/organization-chat` — connect Settings to a library MCP URL from this publisher.
