/**
 * Agents recommend labels and aliases for a published item without touching
 * its text. The suggestion is an ordinary edit of the working row that changes
 * only labels and aliases, so it follows the library's write mode exactly like
 * update_item:
 *   - Review Lock: the item goes Pending, the published copy stays live for
 *     Readers, and a person approves (Publish) or rejects (Cancel) it on the
 *     item page, where "What changed" lists the Labels / Aliases change.
 *   - Review Unlock: the change is live at once (a new published version).
 * Citations follow the published copy, so the version only moves on Publish
 * (or an Unlock save), as with any other edit.
 */
import type { Database } from "./types.ts";
import type { ItemRow } from "./models.ts";
import { parseLabelField } from "../items/schema.ts";
import { getLibraryItem, updateItem } from "./items.ts";
import { labelsEqual } from "./query-helpers.ts";

export type LabelSuggestionInput = {
  add_labels?: string[];
  remove_labels?: string[];
  add_aliases?: string[];
  remove_aliases?: string[];
};

export type LabelSuggestionResult =
  | { ok: true; item: ItemRow; changed: true; labels: string[]; aliases: string[] }
  | { ok: true; item: ItemRow; changed: false }
  | { ok: false; reason: "not_found" | "not_published" | "empty"; message: string };

/** Same normalization as the Labels form field: trimmed, lower case, unique, 40 chars, at most 20. */
function normalize(values: string[]): string[] {
  return parseLabelField(values.map((value) => value.replace(/,/g, " ")).join(","));
}

function applyChange(current: string[], add: string[] | undefined, remove: string[] | undefined): string[] {
  const drop = new Set(normalize(remove ?? []));
  const kept = current.filter((value) => !drop.has(value.trim().toLowerCase()));
  return normalize([...kept, ...normalize(add ?? [])]);
}

/** Labels and aliases after the suggestion, without saving. */
export function plannedLabels(
  item: Pick<ItemRow, "labels" | "aliases">,
  input: LabelSuggestionInput,
): { labels: string[]; aliases: string[] } {
  return {
    labels: applyChange(item.labels, input.add_labels, input.remove_labels),
    aliases: applyChange(item.aliases ?? [], input.add_aliases, input.remove_aliases),
  };
}

export async function suggestLabels(
  db: Database,
  libraryId: string,
  id: string,
  input: LabelSuggestionInput,
  actorSub: string,
  options: { expectedRevision?: number } = {},
): Promise<LabelSuggestionResult> {
  const empty = [input.add_labels, input.remove_labels, input.add_aliases, input.remove_aliases].every(
    (list) => !list || list.length === 0,
  );
  if (empty) {
    return { ok: false, reason: "empty", message: "Send at least one of add_labels, remove_labels, add_aliases, remove_aliases." };
  }
  const existing = await getLibraryItem(db, libraryId, id, { publishedOnly: false });
  if (!existing) return { ok: false, reason: "not_found", message: `No item with id ${id}` };
  // Published, or Pending with its published copy still live.
  const live = existing.status === "published" || existing.has_pending_changes === true;
  if (!live) {
    return {
      ok: false,
      reason: "not_published",
      message: "suggest_labels is for published items. This item is not published; edit it with update_item instead.",
    };
  }
  const next = plannedLabels(existing, input);
  if (labelsEqual(next.labels, existing.labels) && labelsEqual(next.aliases, existing.aliases ?? [])) {
    return { ok: true, item: existing, changed: false };
  }
  const row = await updateItem(
    db,
    id,
    {
      name: existing.name,
      labels: next.labels,
      aliases: next.aliases,
      summary: existing.summary,
      body: existing.body,
      details: existing.details,
    },
    actorSub,
    { libraryId, expectedRevision: options.expectedRevision },
  );
  if (!row) return { ok: false, reason: "not_found", message: `No item with id ${id}` };
  return { ok: true, item: row, changed: true, labels: next.labels, aliases: next.aliases };
}
