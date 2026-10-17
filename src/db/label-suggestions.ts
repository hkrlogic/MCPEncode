/**
 * Agents recommend labels for a published item without touching its text:
 * categories ("security") and the other words people search with ("phished",
 * "suspicious email") are both labels. The suggestion is an ordinary edit of
 * the working row that changes only labels, so it follows the library's write
 * mode exactly like update_item:
 *   - Review Lock: the item goes Pending, the published copy stays live for
 *     Readers, and a person approves (Publish) or rejects (Cancel) it on the
 *     item page, where "What changed" lists the Labels change.
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
};

export type LabelSuggestionResult =
  | { ok: true; item: ItemRow; changed: true; labels: string[] }
  | { ok: true; item: ItemRow; changed: false }
  | { ok: false; reason: "not_found" | "not_published" | "empty"; message: string };

/** Same normalization as the Labels form field: trimmed, lower case, unique, 40 chars, at most 20. */
function normalize(values: string[]): string[] {
  return parseLabelField(values.map((value) => value.replace(/,/g, " ")).join(","));
}

/** Labels after the suggestion, without saving. */
export function plannedLabels(item: Pick<ItemRow, "labels">, input: LabelSuggestionInput): string[] {
  const drop = new Set(normalize(input.remove_labels ?? []));
  const kept = item.labels.filter((value) => !drop.has(value.trim().toLowerCase()));
  return normalize([...kept, ...normalize(input.add_labels ?? [])]);
}

export async function suggestLabels(
  db: Database,
  libraryId: string,
  id: string,
  input: LabelSuggestionInput,
  actorSub: string,
  options: { expectedRevision?: number } = {},
): Promise<LabelSuggestionResult> {
  if (!input.add_labels?.length && !input.remove_labels?.length) {
    return { ok: false, reason: "empty", message: "Send add_labels, remove_labels or both." };
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
  if (labelsEqual(next, existing.labels)) {
    return { ok: true, item: existing, changed: false };
  }
  const row = await updateItem(
    db,
    id,
    {
      name: existing.name,
      labels: next,
      summary: existing.summary,
      body: existing.body,
      details: existing.details,
    },
    actorSub,
    { libraryId, expectedRevision: options.expectedRevision },
  );
  if (!row) return { ok: false, reason: "not_found", message: `No item with id ${id}` };
  return { ok: true, item: row, changed: true, labels: next };
}
