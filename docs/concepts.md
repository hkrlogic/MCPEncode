# Concepts

How MCPEncode works: the words, the roles, the write modes, the MCP tools and the architecture. Setup is in [README.md](../README.md) and [deploy.md](deploy.md).

## Words

Use exactly these words in UI text, docs and code. Do not invent synonyms (vault, notebook, portal, record, document).

| Word | Meaning |
| --- | --- |
| **Library** | A named set of items with one schema, one Connect link and one Access list. There are many libraries, not one global pile. |
| **Item** | One entry in a library: name, labels, aliases, summary, and a markdown body or template fields. |
| **Aliases** | Other words people use for an item ("phished", "suspicious email"). Search matches them like labels. Not shown as tags. |
| **Publish** | A person approves an item. Readers and Reader keys only ever see published items. |
| **Connect link** | A library's MCP address, with a secret token. One link reaches one library. The token is stored only as a SHA-256 hash, so the full link is shown once; to get a new one, rotate it. |
| **Reader** / **Publisher** | Per-library roles, granted under **Access**. |
| **Site admin** | The one app-wide admin role: Accounts, add libraries, open every library, hard-delete. The first account is the Site admin. (Shown as "SA" in some UI and logs.) |
| **Shelf** | A group of libraries searched together. |
| **Reader key** | A static Reader credential for one library, for a shared agent. |
| **Entity key** | A stable id (e.g. a hostname) so repeated syncs update one item instead of adding new ones. |

## Roles

- **Site admin**: everything, in every library. Creates accounts (built-in sign-in).
- **Publisher** (per library): add, edit, Publish and archive items; change the write mode; create the Reader key; see the audit log; may delete their library. Only the Site admin hard-deletes items.
- **Reader** (per library): read published items.
- Everyone else can sign in but sees no library until granted Access.

Disabling or demoting an account takes effect at once: sessions, MCP tokens and refreshes are re-checked on every request.

## Status and write modes

Items move `draft` (Pending) → `published` (optionally `archived`). Reader connections see only published items.

**Published while Pending.** With Review Lock, editing a published Item (by a person or an agent) puts the edit in Pending, and the **last published version stays live**: Readers, Reader keys and agents keep getting it from `list_items`, `open_item`, `search_shelf` and full-text search, and the draft text is never searched or returned for them. **Publish** replaces the live version with the edit; **Cancel** drops the edit and keeps the live version. Publishers see the draft in the web UI with the banner *"Pending changes — agents still see the published version"*, the change list, and the published copy. An Item that was never published stays hidden while Pending. **Unpublish**, **Archive** and **Restore** hide the Item as before. On disk: the edit is the working row (`status = 'draft'`), the live version is `published_snapshot`, and `published_live = true` marks it as still live; Reader queries read the `items_live` view.

Each library has a **write mode**, chosen when it is added and changed later in the UI only (never over MCP):

- **Review Lock** (default, stored as `reviewed`): agent and human saves go to Pending; a person Publishes.
- **Review Unlock** (stored as `direct`): a successful save is published at once. For trusted automation output.

**Revert to published** (item Diff / ⋯ menu) restores the last published copy into the draft; **Revert to previous published** goes one Publish further back. Revert leaves the item Pending until Publish; the live version does not change. Details: [revert-to-published.md](revert-to-published.md).

Library schema (starters, Custom tables, agent-proposed fields that a person approves): [library-schema-v1.md](library-schema-v1.md).

## MCP tools

Each Connect link is one library. Tools offered depend on the caller's role in that library.

| Tool | Who | Does |
| --- | --- | --- |
| `whoami` | anyone | Identity, library, role |
| `list_items` | Reader+ | Look up by question (`q`) or browse. One clear match returns the full item. Returns the published version; Publisher connections also get `status` and `has_pending_changes`. |
| `open_item` | Reader+ | Full item by id (published version). Publishers may pass `version: "draft"` to read a Pending edit. |
| `search_shelf` | Reader+ | Published summaries across the library's shelf |
| `create_item` / `update_item` | Publisher | Save: Pending (Review Lock) or published (Review Unlock) |
| `suggest_labels` | Publisher | Add or remove labels and aliases on a **published** item without touching its text: Pending for a person to approve (Review Lock) or live at once (Review Unlock) |
| `delete_item` | Publisher | Remove an item |
| `create_library` / `propose_table` / `propose_field` | Publisher | Design a library; a person approves the schema |
| `list_audit` | Publisher, Site admin | Who called which tool in this library |

**How `list_items q=` searches.**
1. Every word must match (name, labels and aliases, summary, then body; the full-text index applies English stemming). Aliases score exactly like labels.
2. If nothing matches every word, any word may match. A clear winner that matched on its name or labels, and on most of the words, is returned as the one answer. Weaker candidates come back as **"Did you mean"** suggestions, which the agent must open and check before citing.
3. Still nothing: words that appear nowhere in the library's names, summaries, labels or aliases are corrected to the closest library word (1–2 typos), and steps 1–2 run again.

A word that is only a label several items share (for example `runbook`) returns those items as a list, not one of them as "the" answer. Questions with no word in common with the library are still refused. `search_shelf` falls back from the exact phrase to "every word somewhere in name, summary, labels or aliases".

**Aliases and label suggestions.** Each item has an editable **Aliases** field (comma-separated, lower case, up to 20 of 40 characters). Aliases are part of the published copy, so changing them is an ordinary edit: under Review Lock it goes Pending and Readers keep searching the published aliases until Publish. Agents fix search misses with `suggest_labels` (`add_labels`, `remove_labels`, `add_aliases`, `remove_aliases`, optional `reason` and `expected_revision`):
- It only works on published items (including ones with a Pending edit, which it joins). Name, summary and body are never changed; use `update_item` for drafts.
- **Review Lock:** the item goes Pending. "What changed" lists **Labels** and **Aliases** before and after. A person approves with **Publish** or rejects with **Cancel**, which restores the published labels and aliases.
- **Review Unlock:** the change is live at once.
- Readers and Reader keys do not get the tool. Every call is audit-logged as `suggest_labels` (item id, resulting labels and aliases, reason). Approve and reject are logged by the existing publish and cancel events.
- Citations follow the published copy: the version moves only when a suggestion is published (or saved under Review Unlock).

**Citations.** Every published item that `list_items`, `open_item` or `search_shelf` returns carries a citation for its **published** copy (never a Pending draft):
- `version`: counts publishes, Review Unlock saves and Reverts.
- `published_at` and `updated_at` (ISO 8601).
- `published_by`: the account username, when known.
- `url`: the item page under `PUBLIC_BASE_URL`.
- `cite_as`: a ready string, for example `"VPN Troubleshooting" (Help Desk Runbooks), version 3, published 2026-10-13 by dana.publisher. https://…/items/<id> [item <id> v3]`.

Never-published drafts say `citation: none`. Items published before this release start at version 1, with no recorded publisher.

**Edit conflicts.** Publisher results that return a full item (`open_item`, a single-match `list_items`, `create_item`, `update_item`) include `revision`. Pass it back as `expected_revision` on `update_item`: if anyone saved the item since, nothing is saved and the tool returns a conflict with `current_revision`, so the agent can re-read and reapply. Without `expected_revision` the last save wins, as before. The web edit form does the same check and shows the latest copy when it fails.

There is **no publish, approve, write-mode or revert tool.** Those stay with people in the web UI. Tool output labels item content as data, not instructions.

**Summaries.** Every item has a summary: the short text lookups return before an item is opened. General libraries build it from the body (text before the first table, up to 500 characters), and keep doing so after a person approves an extra field (`summary` stays optional there). Policy, Procedure and Custom libraries take a required one-line `summary` (up to 160 characters).

## Connecting

- **Connect link** (`/libraries/<id>/mcp/<token>`): paste into the MCP client. The client signs in (built-in sign-in: it registers itself, the person enters a password and clicks **Allow** on the consent page).
- **Header form**: `/libraries/<id>/mcp` with `X-Library-Token: <token>`, which keeps the token out of URLs and logs.
- **Reader key**: `Authorization: Bearer <key>` for a shared read-only agent, no sign-in.

Rotating the Connect link (**Connect → Rotate**) invalidates the old token in both forms; Access grants stay.

The token is stored only as a SHA-256 hash (plus its last four characters for display). The full link appears once: after **Create**, **Copy template** or **Rotate**, on the next page load, with a **Copy** button. Afterwards Connect shows the masked link (`…/mcp/…a1b2`) and a **Rotate** button. Lost the link? Rotate to get a new one; clients using the old link must be updated. Readers never see the full link; a Publisher hands it out. Plain SHA-256 (not an HMAC with `SESSION_SECRET`) is used because tokens are 32 random bytes, and rotating `SESSION_SECRET` must not break every link.

## Approving apps

Desktop apps return the sign-in to the person's own machine, so they need no approval. A hosted web app returns it to its own `https://` host, which a Site admin must approve once: on the sign-in page (**Approve <host> and continue**) or under Settings → **Apps** (Approve, Deny, Revoke). `OAUTH_REDIRECT_HOSTS` pre-approves hosts from the environment. Each person still sees the Allow page. Details: [deploy.md → Approving apps](deploy.md#approving-apps).

## Architecture

One Node.js 22 process (Express 5, TypeScript run by `tsx`, no build step) and PostgreSQL 16+.

```
browser ──► web UI (server-rendered HTML + public/*.js)  ┐
MCP client ─► /libraries/<id>/mcp[/<token>]  (MCP over HTTP) ├─► Express app ─► Postgres
                /id/*  built-in OAuth 2.1 sign-in (or external OIDC) ┘
```

- `src/index.ts`: startup (config, database + migrations, sign-in, HTTP server).
- `src/config.ts`: reads and validates the environment; [`src/env-schema.ts`](../src/env-schema.ts) lists every variable.
- `src/auth/`: built-in OAuth server (`embedded-idp.ts`), token verification, roles, sessions, sign-in throttle.
- `src/http/`: Express app, routes, pages, rate limits, `/healthz`.
- `src/mcp/`: MCP server and tools.
- `src/db/`: Postgres client, migrations runner, queries. `migrations/` holds the SQL, applied in order at startup.
- `src/items/`, `src/markdown/`: item schemas and templates; Markdown sanitising and tables.
- `public/`: browser scripts and styles (strict CSP: no inline script).

State that is **not** in Postgres: pending sign-ins, consent answers, authorization codes and rate-limit counters (memory, one process). See [known-limitations.md](known-limitations.md).

## Not built yet

- Library starters / schema integrity follow-ups: fork-with-items, retire source ([library-schema-v1.md](library-schema-v1.md)).
- Site admin break-glass recovery (today: reset through Postgres).
- Sign-in domain allow/deny lists; TOTP for built-in accounts.
- Usage dashboard; whole-library export (item Markdown export exists).
