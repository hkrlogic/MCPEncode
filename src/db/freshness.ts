/**
 * Freshness: review-by dates on published items, the owner review queue, and
 * "Still accurate". review_by lives outside the published copy, so confirming
 * an item changes no content, no revision and no citation version.
 */
import type { Database } from "./types.ts";
import { allRows, getRow } from "./query-helpers.ts";

/** Review period: Policy and Procedure items get publish day + this on every publish; Still accurate moves any item this far. */
export const REVIEW_DAYS = 90;
/** The queue shows items due within this many days, and overdue ones. */
export const REVIEW_QUEUE_DAYS = 14;

/** UTC calendar day, YYYY-MM-DD. */
export function todayIso(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Past review: the review-by day is before today (due today is not stale yet). */
export function isPastReview(reviewBy: string | null | undefined, now = Date.now()): boolean {
  return typeof reviewBy === "string" && reviewBy !== "" && reviewBy < todayIso(now);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Items with a live published copy. */
const HAS_LIVE_COPY =
  "published_snapshot IS NOT NULL AND (status = 'published' OR (status = 'draft' AND published_live))";

/**
 * "Still accurate": a person re-confirms the published copy. Moves review_by
 * to today + 90 days and
 * records who confirmed. Content, revision and citation version do not change.
 */
export async function confirmStillAccurate(
  db: Database,
  libraryId: string,
  itemId: string,
  actorSub: string,
): Promise<{ reviewBy: string } | undefined> {
  const row = await getRow<{ review_by: string }>(
    db,
    `UPDATE items SET review_by = ?::date + ?::int, reviewed_at = ?, reviewed_by = ?
     WHERE id = ? AND library_id = ? AND ${HAS_LIVE_COPY}
     RETURNING review_by::text AS review_by`,
    todayIso(),
    REVIEW_DAYS,
    Date.now(),
    actorSub,
    itemId,
    libraryId,
  );
  return row ? { reviewBy: row.review_by } : undefined;
}

/** Owner sets or clears the review-by date by hand. */
export async function setReviewBy(
  db: Database,
  libraryId: string,
  itemId: string,
  reviewBy: string | null,
): Promise<boolean> {
  const rows = await allRows<{ id: string }>(
    db,
    "UPDATE items SET review_by = ?::date WHERE id = ? AND library_id = ? RETURNING id",
    reviewBy,
    itemId,
    libraryId,
  );
  return rows.length > 0;
}

export type ReviewQueueRow = {
  id: string;
  name: string;
  review_by: string;
  reviewed_at: number | null;
  reviewed_by_name: string | null;
  overdue: boolean;
};

/** Live items in one library due within REVIEW_QUEUE_DAYS, or overdue. Soonest first. */
export async function reviewQueue(db: Database, libraryId: string, now = Date.now()): Promise<ReviewQueueRow[]> {
  const rows = await allRows<{
    id: string;
    name: string;
    review_by: string;
    reviewed_at: number | string | null;
    reviewed_by_name: string | null;
  }>(
    db,
    `SELECT live.id, live.name, i.review_by::text AS review_by, i.reviewed_at, a.username AS reviewed_by_name
     FROM items_live live
     JOIN items i ON i.id = live.id
     LEFT JOIN accounts a ON a.id = i.reviewed_by
     WHERE live.library_id = ? AND live.status = 'published' AND i.review_by IS NOT NULL
       AND i.review_by <= ?::date + ?::int
     ORDER BY i.review_by ASC, LOWER(live.name) ASC
     LIMIT 500`,
    libraryId,
    todayIso(now),
    REVIEW_QUEUE_DAYS,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    review_by: row.review_by,
    reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewed_by_name: row.reviewed_by_name,
    overdue: isPastReview(row.review_by, now),
  }));
}

/** review_by and last confirmation for one item (any status). */
export async function itemFreshness(
  db: Database,
  itemId: string,
): Promise<{ reviewBy: string | null; reviewedAt: number | null; reviewedByName: string | null } | undefined> {
  const row = await getRow<{ review_by: string | null; reviewed_at: number | string | null; reviewed_by_name: string | null }>(
    db,
    `SELECT i.review_by::text AS review_by, i.reviewed_at, a.username AS reviewed_by_name
     FROM items i LEFT JOIN accounts a ON a.id = i.reviewed_by WHERE i.id = ?`,
    itemId,
  );
  if (!row) return undefined;
  return {
    reviewBy: row.review_by,
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedByName: row.reviewed_by_name,
  };
}
