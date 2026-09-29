# MCPEncode

Publisher for organization libraries. Open this folder (`~/MCPEncode`) for publisher work — not the kiosk workspace.

GitHub: `hkrlogic/MCPEncode`.

## Product

You keep **libraries** of **items**. Auth is to a library. Each item has a **name**, **labels**, a **summary**, and **sections** (for now: markdown **body** plus policy/procedure templates). **Publish** a library so people and agents can look its items up.

| Word | Meaning |
| --- | --- |
| **Library** | What someone publishes (hosted MCP). Many libraries, not one global pile. |
| **Item** | One thing in a library. |
| **Section** | Typed chunk on an item (Table, Checklist, Details, Description) — body-shaped for now. |
| **Publisher** | This app. |
| **Kiosk** | Separate chat UI in `~/organization-chat/ollama-mcp-chat`. |

**MCP** is plumbing (Cursor, kiosk, Perplexity, etc.). Do not invent synonyms (vault, notebook, portal).

## Status gate

Items: `draft` → `published` (optional `archived`). Readonly MCP only sees published. Edit saves drafts; publish is an explicit action.

## Run

```bash
cd ~/MCPEncode
docker compose up -d mariadb
npm start
```

Open `http://127.0.0.1:3000/`. MCP: `http://127.0.0.1:3000/mcp`.

## Related

Kiosk workspace: `~/organization-chat` — connect Settings to this publisher’s MCP URL.
