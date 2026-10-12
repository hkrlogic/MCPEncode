# Revert to last published — feature plan

Status: implemented.  
Related: item `published_snapshot`, Publish Diff UI, Review Lock / Review Unlock.

**Naming note:** Today **Restore** means “un-archive → Pending” (`restoreItem`). This feature must **not** reuse that word in the UI. Prefer **Revert to published** (code: `revertToPublished`).

## Problem

After an edit (human or agent), the working item can diverge from what readers last saw. Diff shows the gap, but there is no action to put the working fields back to the last published copy. Accidental overwrite has no undo.

## Goal

A publisher can **revert the working item to its last `published_snapshot`** in one confirmed action, without inventing full version history.

## Non-goals (this feature)

- Full revision history / multi-version timeline  
- Optimistic concurrency (separate, next integrity slice)  
- Soft-delete / trash  
- MCP tool to revert (Publish stays human-only; revert stays human-only)  
- Reverting schema / field proposals  
- Changing `entity_key` via revert (snapshot does not store it; key stays as-is)

## What already exists

| Piece | Today |
| --- | --- |
| `published_snapshot` | name, labels, summary, body, details, published_at |
| Review Lock edit | Edit goes to Pending; the snapshot **stays live** for Readers (v0.2, `published_live`) |
| Publish | Writes working fields into snapshot; status → published |
| Diff UI | Compares working item ↔ snapshot |
| Restore (menu) | Archive → Pending only — **different feature** |

## Behavior

### When the action is available

Show **Revert to published** only when:

1. Caller is a **publisher** on the library (`records.write`).  
2. Item has a non-null `published_snapshot`.  
3. Working fields **differ** from the snapshot (same comparison as Diff).  
4. Item is not mid a state where revert is meaningless — see below.

Recommended status rules:

| Status | Revert? |
| --- | --- |
| **Pending (`draft`)** with snapshot | **Yes** — primary case (edited after publish, or unpublished) |
| **Published** with no working drift | Hidden / disabled (no changes) |
| **Published** | Normally no drift under Review Lock (edit forces draft). Under Review Unlock, live row ≈ snapshot after each save — revert rarely applies; if somehow drifted, allow only when Diff would show changes |
| **Archived** | **No** — use existing Restore (un-archive) first; then revert if needed |

### What revert does

In one transaction:

1. Load item `FOR UPDATE`.  
2. Refuse if no snapshot, or no Diff, or status is archived.  
3. Copy snapshot → working columns:  
   `name`, `labels`, `summary`, `body`, `details`  
4. **Do not** change `entity_key`, `id`, `library_id`, or `published_snapshot` (snapshot stays the last published truth).  
5. Set status to **`draft` (Pending)** — even if it was already draft.  
   - Rationale: reverted content is “ready to re-Publish,” not silently live. Matches Review Lock safety.  
   - Exception option (decide in build): if library is Review Unlock **and** product wants immediate live revert, set `published` and refresh snapshot — **default recommendation is still Pending + human Publish** so revert never surprises readers.  
6. Write audit: `ui.revert_to_published` (success/fail).  
7. Redirect to item with notice `reverted`.

Readers/kiosk: unchanged until Publish (Review Lock). Under Review Unlock with “stay Pending” default, same — revert is not live until Publish. (If we later choose live revert on Unlock libraries, document it loudly.)

### Confirm copy

Something like:  
“Revert this item to the last published version? Your current edits will be replaced. The item will stay Pending until you Publish.”

## UI

- On the item page, near **Changes since published** (Diff sheet / ⋯ menu):  
  **Revert to published** — only when Diff shows changes and snapshot exists.  
- Confirm dialog (same pattern as archive / rotate).  
- After success: notice  
  “Reverted to the last published version. Item is Pending — Publish when it should be live again.”  
- Keep archive **Restore** label unchanged (un-archive only).

## MCP / agents

- **No** `revert_item` tool.  
- Agent instructions already say publishing is human-only; add one line: reverting to last published is a publisher UI action only.  
- Agents keep using `update_item`; humans undo bad writes via Revert + Publish.

## Review Unlock nuance

| Mode | Typical path |
| --- | --- |
| Review Lock | Edit → Pending + old snapshot → **Revert** restores snapshot into working fields → still Pending → Publish |
| Review Unlock | Successful save updates snapshot to match live → Diff empty → Revert hidden. Integrity for Unlock is mostly concurrency + care; Revert helps less unless we later keep a “previous snapshot” ring buffer (**out of scope**) |

Call this out in UI hint on Unlock libraries: “Revert uses the last published snapshot. In Review Unlock, each save refreshes that snapshot.”

## Storage / integrity notes

- Snapshot JSON already on `items.published_snapshot` — **no migration** required for v1 of this feature.  
- Revert overwrites working row only; snapshot unchanged until next Publish.  
- If snapshot JSON is unreadable: refuse revert; show error; do not partial-apply.  
- `entity_key` unchanged so agent upserts do not retarget a different entity after revert.

## Audit

| tool | when |
| --- | --- |
| `ui.revert_to_published` | Publisher confirms revert |

Optional detail: item id + `published_at` from snapshot.

## Tests (required)

1. Publish → edit (Pending) → revert → working fields match old snapshot; status Pending; snapshot unchanged.  
2. Revert with no snapshot → refused.  
3. Revert when Diff empty → refused / no-op.  
4. Archived item → refused (must Restore from archive first).  
5. Reader / CSRF → 403.  
6. Policy/Procedure/table items: details + body round-trip correctly.  
7. `entity_key` preserved across revert.  
8. UI: button present only when Diff has changes; label is not “Restore”.

## Implementation slices

1. **DB:** `revertToPublished(db, id, actorSub)` + export from `queries`. ✓  
2. **HTTP:** `POST /items/:id/revert-published` + notice + confirm. ✓  
3. **UI:** action in Diff sheet and ⋯ menu; copy/labels. ✓  
4. **Tests:** DB + HTTP + UI visibility (`test/revert-to-published.test.ts`). ✓  
5. **Docs:** AGENTS status-gate one-liner. ✓

No MCP surface in v1.

## Decisions (locked for v1)

1. **After revert, always Pending** — even on Review Unlock libraries. Human Publishes when it should be live again.  
2. **Review Unlock:** hide Revert when snapshot matches live; no previous-snapshot ring buffer.  
3. **Button placement:** Diff sheet (primary) and ⋯ menu (secondary).

## Success criterion

A publisher who accepts a bad edit (or bad agent `update_item` under Review Lock) can get the last published content back in one confirmed click, then choose when to Publish — without SA, SQL, or losing `entity_key`.
