# Changelog

## Unreleased

### Added: item aliases and agent label suggestions ([#35](https://github.com/hkrlogic/MCPEncode/issues/35))

- **Aliases.** Items have an editable **Aliases** field: other words people use, such as `phished, phishing, suspicious email`. `list_items q=`, typo correction and `search_shelf` match and rank aliases the same way as labels. Item pages show them as "Also searched as". `open_item` prints an `aliases:` line, and Markdown export adds `Aliases:`.
- **`suggest_labels` (Publisher MCP tool).** Agents add or remove labels and aliases on a **published** item without changing its name, summary or body.
  - **Review Lock:** the suggestion is Pending. Readers keep the published copy, and the review shows the Labels / Aliases change for a person to Publish or Cancel.
  - **Review Unlock:** it is live at once.
  - Readers don't get the tool. Calls are audit-logged as `suggest_labels`. The citation version moves only when the published copy changes.
- **Migration `021_item_aliases.sql`** adds `items.aliases` (JSONB, default `[]`) and exposes the published aliases in `items_live`. Published copies from before this release have no aliases.

### Changed: new look ([#23](https://github.com/hkrlogic/MCPEncode/issues/23))

The web app now matches the MCPEncode landing page: Inter and JetBrains Mono, stone neutrals, an indigo accent, softer cards and one easing curve. This release changes only CSS, fonts and a few lines of markup. Class names, routes, settings and the database are unchanged.

- **Design tokens** in `public/styles.css`: ink neutrals, indigo accent, danger / warn / success, `--font-sans` / `--font-mono`, radius, shadows, spacing and easing. The original `--bg`, `--ink`, `--muted`, `--line`, `--panel`, `--accent`, `--danger` and `--focus` point at them, and no hard-coded hex colours remain outside `:root`.
- **Fonts:** Inter and JetBrains Mono (SIL OFL 1.1) are self-hosted in `public/fonts` and replace Source Sans 3 and Source Serif 4. Body text is now sans-serif. `scripts/fetch-fonts.sh` fetches the new pair, and `NOTICE` is updated.
- **Base elements and components:** inputs get an indigo focus ring. Buttons (ink primary, secondary, ghost, danger), tags and status pills (with a leading dot), panels, notices, lists, tables, the diff view, the schema segmented control, the write-mode switch and the slide-up sheet are all restyled.
- **Header and sidebar:** the logo mark sits beside the name. The open library has a white raised row with an indigo bar. Connect, Reader key and the ⋯ menu look like secondary buttons.
- **Sign-in, first-run and consent pages:** a centred card under the logo on a faint CSS-only grid, with full-width buttons. No scripts were added and the CSP is unchanged.
- **Accessibility:**
  - Every text colour pair meets WCAG AA (small text never lighter than ink-600, 7.3:1 or more on the app background).
  - The write-mode switch's off state meets 3:1 for UI components.
  - One global `:focus-visible` ring is used throughout, and checkboxes and radios keep a visible focus outline.
  - Pending-item checkboxes now have an accessible name, and the Connect link box can be reached with the keyboard.
  - `prefers-reduced-motion` turns off every transition and animation.
- **Screenshots:** `docs/assets/*.png` were regenerated from `npm run seed-demo` in the new look.

### Changed: better search recall for agents ([#30](https://github.com/hkrlogic/MCPEncode/issues/30))

- **Results.** `list_items q=` no longer needs every word of a natural question to appear in an item. Validation questions against the demo Help Desk library: **16 of 18** now find the right runbook (was 6), including all 5 typos. The Biology tutor questions that were refused ("when is homework due…", "how is the lab report graded") now find the course material. Out-of-scope questions are still refused.
- **How it works.**
  - Every word must match first. Otherwise any word may match: a clear winner anchored on its name or labels is returned, and weaker candidates come back as **"Did you mean"** suggestions (a new result shape with a notice telling the agent to open and check before citing).
  - Otherwise typos are corrected against the library's own name, summary and label words (edit distance 1–2) and the search runs again. A match found this way says which spelling it used.
  - Labels are now scored, so a label shared by several items ("runbook") returns a list instead of one confident answer. Conversational filler words are ignored.
- **`search_shelf`** falls back from the exact phrase to "every word somewhere in name, summary or labels".
- **No migration and no new extension**: typo correction runs in the app over the library's names, summaries and labels (capped at 2,000 items), so `pg_trgm` is not required.

### Added: citations on agent results ([#30](https://github.com/hkrlogic/MCPEncode/issues/30))

- `open_item`, `list_items` (a full item or a list) and `search_shelf` now carry a **citation** for the published copy: `version`, `published_at`, `updated_at`, `published_by`, `url` and a ready `cite_as` string. Readers keep citing the published version while an edit is Pending. Never-published drafts say not to cite them.
- Migration `020_item_citation.sql` adds `items.published_version` and `items.published_by`. A trigger bumps the version whenever the published copy changes (Publish, Review Unlock save, Revert). Existing published items start at version 1, with no recorded publisher.
- The agent instructions ask agents to cite with `cite_as`.

### Added: edit-conflict detection ([#30](https://github.com/hkrlogic/MCPEncode/issues/30))

- Publisher MCP results now include `revision`, the last-saved time of the item's working copy. `update_item` accepts an optional `expected_revision`. When the item changed since then, nothing is saved and the tool returns `Conflict: …` with `current_revision`. The check also runs inside the `UPDATE`, so two parallel saves from the same revision cannot both win.
- The web edit form sends the revision it was opened with. A stale form gets **409**, a short message and the latest saved copy.
- Backward compatible: callers and forms without a revision keep the old last-write-wins behaviour. No migration.

### Fixed: approving a field no longer breaks agent writes ([#30](https://github.com/hkrlogic/MCPEncode/issues/30))

- On a General library, approving an optional field (for example `propose_field` "Review by") used to make `summary` **required** on `create_item` / `update_item`. The next ordinary `update_item {id, name, body}` then failed validation. The summary is now optional again and is derived from the description when omitted, the same as before the approval. The publisher form follows suit. Policy, Procedure, table and custom libraries are unchanged.
- Documented that MCP tool lists are rebuilt on every request, so the new field shows up on the next `tools/list`. A stateless server cannot push `notifications/tools/list_changed`.

## v0.2.1

### Security

- **Connect tokens are no longer stored in plain text.** Postgres keeps only a SHA-256 hash of each Connect token and its last four characters for display. Lookups (link path and `X-Library-Token`) hash the presented token and compare in constant time. Reader keys were already hashed; OAuth refresh tokens were already hashed; `SETUP_TOKEN` stays in the environment.
- No page, log line, audit entry or API response returns a full Connect link after it was shown once. The MCP `create_library` result still includes `mcp_url` for the library it just created.

### Changed (behavior)

- **Owners can no longer re-view an existing Connect link.** The full link is shown once, with **Copy** and a "you won't see this again" note, after Create, Copy template or Rotate. Afterwards **Connect** shows a masked link (`…/mcp/…a1b2`) and a **Rotate** button. To get a link again, rotate it (old links stop working).
- Readers see only the masked link; a Publisher hands out the link.
- The LibreChat config shown with a new Reader key has a placeholder for the URL unless a Connect link was just revealed.

### Migration

- 019 hashes every existing `connect_token` in place into `connect_token_hash` (and `connect_token_last4`), then drops the plaintext column and its index. **Links already handed out keep working.** Idempotent: a second run changes nothing. No downgrade: v0.2.0 cannot read the hashed column, so back up before upgrading if you might roll back.
- On a fresh install nobody has seen the **Main** library's link yet: open Main → **Connect** → **Rotate** to get one.

## v0.2.0

### Changed

- **Review Lock no longer hides an edited Item.** Editing a published Item puts the edit in Pending while its last published version stays live for Readers, Reader keys and agents (`list_items`, `open_item`, `search_shelf`, full-text search, the reader web page). Draft text is never searched or returned for them. **Publish** replaces the live version; **Cancel** drops the edit and keeps it. A never-published Item still stays hidden; Unpublish, Archive, Restore and Delete work as before. Review Unlock libraries are unchanged.
- Publisher pages show *"Pending changes — agents still see the published version"* on such Items, with the published copy next to the change list; the Pending list tags them **Published copy live**.
- MCP for Publisher connections: item output includes `status`, `has_pending_changes` and `version`; list summaries include `has_pending_changes`. By default they show the published version, like Readers; `open_item` takes `version: "draft"` to read the Pending edit. Reader connections get no new fields.
- Audit log: `item.edit_pending`, `item.publish`, `item.publish_replace_live`, `item.discard_pending` and `item.revert_pending`.

### Migration

- 018 adds `items.published_live` and the `items_live` view. Pending Items whose last status change was an edit (or file change) after Publish, with a readable published copy, go live again with that copy. Items that were unpublished on purpose (an `ui.unpublish` audit entry), restored from Archives, never published, or whose stored copy cannot be read stay hidden until someone Publishes them.

### Known limitations

- Item files are not versioned: a file change on a published Item keeps its text live, but Readers see the current file list.

## v0.1.2

### Fixed

- **Allow did nothing in Chrome, then "This sign-in expired".** The site's `form-action 'self'` policy made Chrome block the redirect from **Allow** (and **Deny**) to the app's callback, so the page stayed put; pressing Allow again or reloading then showed *"This sign-in expired. Start again from the app."* The Allow page (also after **Approve <host> and continue**) now lets its form reach that one validated callback: its exact origin for `https://` and loopback callbacks, or its scheme (`cursor:`) for app callbacks. Every other page keeps `form-action 'self'`. With `AUTH_MODE=oidc`, the provider's sign-out page origin is allowed too, so **Sign out** reaches it.
- Sending a used or expired Allow, Deny or Approve form again now shows a page: *"This sign-in was already submitted or has expired. Go back to the app and start again."*
- Settings → Apps, Revoke: the message now says existing access ends within 15 minutes, instead of saying apps were signed out at once.

### Docs

- `docker compose down -v` needs a `.env`; run `scripts/init-env.sh` first.

## v0.1.1

### Added

- **Approving hosted apps in the app.** A hosted MCP client (web connector) whose `https://` callback host is not approved can now register; its host waits for a Site admin. The sign-in page explains it (*"This app's callback host … isn't approved yet. A site admin can approve it."*). A Site admin signing in there gets **Approve <host> and continue**; others see *"Waiting for your site admin to approve this app."* Settings → **Apps** lists waiting, approved and denied hosts with Approve, Deny and Revoke (CSRF-protected, audited). Approved hosts are the app's approvals plus `OAUTH_REDIRECT_HOSTS`. Migration 017 adds `callback_hosts`.
- The log names a refused callback host once per host and client (host, client id, self-reported client name) with a copy-paste `OAUTH_REDIRECT_HOSTS=<host>` line. `/id/register` errors include `callback_host`.

### Security

- Only https DNS hostnames can be approved: IP literals, user info, fragments and plain http stay refused, as do launcher and unknown single-word schemes. Callbacks still match the registered address exactly, and no code is sent to a host before it is approved.
- At most 200 hosts wait for approval; one address may add 10 new waiting hosts per hour.
- Revoking (or denying) a host deletes the refresh tokens of every client with a callback on it.

### Changed

- `/id/register` with an unapproved `https://` callback now returns 201 (the host waits for approval) instead of 400. Sign-in still cannot finish until the host is approved.

## v0.1.0

First tagged release.

### Breaking changes

- **Fewer settings.** These environment variables were removed. If one is still set, the app starts, ignores it and logs one line naming it:
  - `OAUTH_LEGACY_CLIENT`: the shared legacy client id is gone (below).
  - `OAUTH_REGISTER_RATE_LIMIT` (20/hour), `OAUTH_AUTHORIZE_RATE_LIMIT` (60/minute), `OAUTH_MAX_PENDING_CLIENTS` (1000), `OAUTH_MAX_PENDING_CLIENTS_PER_ADDRESS` (20), `OAUTH_PENDING_CLIENT_TTL_MINUTES` (60), `PASSWORD_HASH_CONCURRENCY` (2), `OAUTH_REFRESH_MAX_DAYS` (30): now fixed at the value shown, which was the default.
  - `OAUTH_ALLOWED_SCHEMES`, `OAUTH_ALLOW_ANY_HTTPS_REDIRECT`: callbacks are loopback, reverse-DNS app schemes, `cursor`/`vscode`/`vscode-insiders`/`claude`, or an `https` host listed in `OAUTH_REDIRECT_HOSTS`.
  - `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL`: `ALLOW_INSECURE_HTTP` covers it.
  - `AUTH_MCP_AUDIENCE_SHARED`: with `AUTH_MODE=oidc`, `AUTH_MCP_AUDIENCE` is always required.
  - `ALLOW_OPEN_SETUP`: the first account always needs the setup code.
- **The shared legacy client id is gone.** Every MCP client registers its own client id. A client still using the shared legacy client id gets `unknown client_id`; reconnecting it registers a new id. Cursor, VS Code, Claude Code, Claude Desktop (`mcp-remote`) and MCP Inspector register on their own.
- **`AUTH_MODE=oidc` requires `AUTH_MCP_AUDIENCE`.** Set the audience your identity provider puts in MCP access tokens; without it the app refuses to start ([docs/oidc.md](docs/oidc.md)).
- **`http://` `PUBLIC_BASE_URL` on a non-loopback host refuses to start.** Use `https://` behind a TLS proxy, or set `ALLOW_INSECURE_HTTP=true` deliberately.
- **Single-word callback schemes are refused** unless they are `cursor`, `vscode`, `vscode-insiders` or `claude`. Browser-launcher schemes are always refused. Remote `https` callbacks (hosted clients such as claude.ai or LibreChat) need their host in `OAUTH_REDIRECT_HOSTS`.
- **Unused client registrations expire after 1 hour** (was 24 hours), and one address may hold at most 20 of them.
- **New names.** Cookies are now `mcpencode_*`, so everyone signs in once more after the upgrade. Built-in sign-in tokens carry `mcpencode:*` scopes (older tokens keep working). The default web client id is `mcpencode-web`: with `AUTH_MODE=oidc`, set `WEB_CLIENT_ID` to the client id registered at your issuer. The default database user and name are `mcpencode`: an existing `.env` keeps its `POSTGRES_USER` and `POSTGRES_DATABASE` lines, but if yours has none and you relied on the old defaults, add `POSTGRES_USER=mpos` and `POSTGRES_DATABASE=mpos`.

### Security

- `/id/register` and `/id/authorize` are rate limited per address; `/id/register` takes at most 8 callbacks and 8 KB.
- Per-address cap on pending dynamic client registrations (IPv6 per /64), alongside the global cap.
- Known-good sign-in addresses (the sign-in throttle bypass) are kept in Postgres, hashed, so they survive a restart (migration 016).
- One warning is logged when a request carries `X-Forwarded-For` but `TRUST_PROXY` is not set: behind a proxy, all clients would share one address for rate limits.

### Setup and docs

- `scripts/init-env.sh` fills every missing secret (`SESSION_SECRET`, `SETUP_TOKEN`, `POSTGRES_PASSWORD`) and never changes a set value. `.env.example` is down to the lines people change.
- `npm run check-env` validates a `.env` and lists missing, removed and unknown settings. `src/env-schema.ts` lists every setting; docs/deploy.md has the same table.
- `AGENTS.md` is the guide for AI coding agents (deploy, verify, fix, test); `llms.txt` indexes the docs. New: docs/concepts.md, docs/oidc.md, docs/known-limitations.md.

### Known limitations

See [docs/known-limitations.md](docs/known-limitations.md): single instance only, Connect tokens stored in plain text (hashed since v0.2.1), Review Lock hides edited items until published again (fix planned for v0.2).
