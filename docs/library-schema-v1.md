# Library starters, schema integrity, and copy — v1 draft

Status: draft (product design, not implemented).  
Vocabulary: **library**, **item**, **section**, **Publish**, **Connect**, **Approve**. Do not say database, dataset, store, catalog, vault, or notebook for a library.

## Product spine

MCPEncode is a publisher for **libraries** of **items**. Auth is to a library. Each item has a **name**, **labels**, a **summary**, and a body shaped by that library’s schema. People and agents look items up over the library’s **Connect** link (MCP).

MCP is plumbing. External sync lands as items (via existing write tools / `entity_key` upserts), not as a live proxy to foreign systems. An in-app MCP chat client is out of scope.

## Goals

- Starters suggest a shape; humans stay in control of structure.
- After a schema is set, history does not morph (data integrity).
- Structural change is gated: agent may **propose**, human must **Approve**.
- Wrong or incomplete shape → **new library** (template copy), not silent ALTER of a living library.
- Keep the mental model small: starters, Approve, Publish, Connect.

## Non-goals (v1)

- Becoming a general database (migrations, renames, type changes, joins, query builders).
- Cross-library agent migrate/copy tools.
- Built-in external connector framework (use MCP writes / automation into a library).
- Copying items when forking a library (see [Next](#next-required-fork-with-items--retire-source)).
- Dropbox / folder metaphors in UI copy.

---

## Starter packs

A **starter** is a suggested field set plus design/write instructions for chat. It is not an forever-sealed shape (except sealed packs below).

### v1 set (illustrative — exact names TBD)

| Starter | Kind | At design time |
| --- | --- | --- |
| Documents (today’s General) | Thin | Name, labels, summary, description — little or no field workshop |
| Policy | Sealed | Fixed fields; confirm name + write mode; no redesign |
| Procedure | Sealed | Fixed fields; confirm name + write mode; no redesign |
| 1–2 guided starters (e.g. service tickets) | Guided | Suggest fields; human may edit before lock |
| Custom | Open | Empty/minimal suggestions; same design conversation as today |

### Instructions vs schema

| Layer | Role |
| --- | --- |
| Starter instructions | Guide design chat and how agents should fill items |
| Library schema | Approved field contract; enforced on every write |
| Write path | `create_item` / `update_item` validate against schema only — instructions do not replace validation |

---

## Schema lifecycle

### Create

1. Add library → pick starter (or Custom).
2. Design chat uses starter instructions → suggested fields (guided/custom) or sealed set.
3. Human adjusts fields **before** lock (guided/custom only).
4. Confirm → create / propose as today.
5. Human **Approves** structural result in the publisher → schema **locks**.

### After lock (integrity rules)

| Allowed | Not allowed |
| --- | --- |
| Edit library settings (name, Access, write mode, Connect rotate) | Rename an existing field |
| Edit item content (subject to Review Lock / Unlock + Publish) | Remove an existing field |
| **Add** optional field(s): agent proposes → human Approves | Change an existing field’s type or meaning |
| | Reuse an old field key for a new meaning |

**Add-only:** new fields are **optional** so existing items stay honest (absent ≠ invented). Agents must not invent values for missing fields.

**Wrong shape:** copy template to a **new** library (see below), or stop using an old field and add a better optional one — never morph the locked keys.

### Propose → Approve (fields)

Same product beat as table Approve today:

- Agent may propose new optional field(s) (label, type, required = no).
- Propose does **not** apply over MCP.
- Human Approves in the publisher; only then do UI and MCP write schemas include the field.

Sealed starters (Policy / Procedure): no add-field in v1 (or explicitly off).

---

## Copy library (v1: template only)

**Copy library** creates a **new** library seeded from an existing one’s schema (and starter / write-mode defaults).

| Copied in v1 | Not copied in v1 |
| --- | --- |
| Schema (field set) | Items |
| Write mode default | Access grants |
| Starter identity (for UI/copy) | Connect token / URL |

At **inception** of the copy, the human may still add or adjust fields, then **Approve** locks the new library. The source library is unchanged.

New library always gets its own Access list and Connect link.

---

## Writes and external data (unchanged pattern)

- **Review Lock:** creates/updates stay Pending until human Publish.
- **Review Unlock:** successful saves are live; prefer `entity_key` upserts (one item per entity).
- Automation and agents use the library MCP as the ingest path into items.
- Readers and reader MCP see published items only.

---

## Agent boundaries (v1)

| In scope | Out of scope |
| --- | --- |
| Design chat for starters / Custom | Applying schema without human Approve |
| `create_item` / `update_item` within the connected library | Cross-library copy or migrate tool |
| Propose new optional fields | Renaming/removing fields |
| Lookups: `list_items` / `open_item` | Live proxy to external systems |

Each Connect link remains **one library**.

---

## Editing a library (what “edit” means)

DB-like integrity rails, not database parity.

**You can edit:** item content, Access, write mode, Connect, library name, and (via Propose → Approve) **append optional fields**.

**You cannot edit in place:** the meaning or identity of existing fields. That path is **new library** (template copy now; fork-with-items next).

UI copy should say this plainly when someone hits a locked field — not offer a fake “edit column” that cannot work.

---

## Next (required): fork with items + retire source

Template-only copy is enough for v1 shape forks. A later, likely **required** feature:

1. **Copy library** including **items** (rules TBD: published-only vs all; new ids; `entity_key` clear or prefix).
2. At inception, allow field adds on the new library, then Approve.
3. **Retire the source library** — human kill (hard-delete, SA) and/or **auto-archive** so the old shelf is not still the live Connect target.

Design that flow as one guided publisher action (“Fork library”) so people are not left with two live libraries and two Connect links by accident. Exact retire semantics (archive library vs archive all items vs revoke Connect) are **TBD** in that feature’s design — not v1.

Until then: template copy only; source stays active unless a human archives/deletes it manually with today’s tools.

---

## User stories (v1)

1. As a publisher, I pick a starter, adjust suggested fields in chat if allowed, and Approve once so the library has a locked schema.
2. As a publisher, I add and Publish items; readers and agents only see what Publish (or Review Unlock) allows.
3. As an agent, I write only fields on the schema; I propose new optional fields and wait for human Approve.
4. As a publisher, I copy a library’s **template** to start a new library, change fields at inception, Approve, and leave the original untouched.
5. As a publisher, I do not get an in-place rename/remove field action; the product tells me to add a field or copy the library.

## User stories (next)

6. As a publisher, I fork a library (template + items), add fields on the new library, Approve, and retire/archive the old library so Connect and readers move to the new shelf.

---

## Open points (small)

- Exact starter names and which guided packs ship in v1.
- Field cap (tables already lean ≤ 12).
- One field proposal vs batch per Approve.
- Whether Documents starter allows add-field or stays thin-and-frozen.
- Retire semantics for the next fork-with-items feature.

## Implementation note

This document is design only. No schema migration or UI work is implied until a follow-up implements slices (e.g. Propose field, Copy library template).
