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
- **Reviewed** (default) — create/update save as Pending; a human Publishes.
- **Direct** — successful create/update is Published immediately.

Choose the mode when adding a library. Publishers can change it later in the UI only (not over MCP).

## Run

```bash
cd ~/MCPEncode
docker compose up -d postgres
npm start
```

Open `http://127.0.0.1:3000/`. Each library has its own MCP link: `http://127.0.0.1:3000/libraries/{id}/mcp` (copy it from Open library). The global `/mcp` URL is retired.

## Access

Grant by IdP `sub` on each library (**reader** or **publisher**). Publishers manage that list. Agents connect with that library’s link only.

## Related

Kiosk workspace: `~/organization-chat` — connect Settings to a library MCP URL from this publisher.
