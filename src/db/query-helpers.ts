/** Shared SQL runners and row mappers used by sibling db modules. */
import type { Database } from "./types.ts";
import { parsePolicyDetails, parseProcedureDetails } from "../items/templates.ts";
import { splitSummaryAndTable } from "../markdown/table.ts";
import type { ItemRow, ItemStatus, PublishedSnapshot } from "./models.ts";

/** Raw items table row before JSON/status parsing. */
export type SqlItem = {
  id: string;
  library_id: string;
  name: string;
  entity_key: string | null;
  labels: string | string[];
  aliases?: string | string[] | null;
  summary: string;
  body: string;
  details: string | null;
  status: string;
  published_snapshot: string | null;
  previous_published_snapshot: string | null;
  /** Set on the items table only: Pending, and the published copy is still live. */
  published_live?: boolean | null;
  /** Set on the items_live view only. */
  has_pending_changes?: boolean | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

/**
 * Item columns for reads. Excludes generated search_tsv so Open item does not
 * pull the full-text document blob over the wire.
 */
export const ITEM_COLUMNS =
  "id, library_id, name, entity_key, labels, aliases, summary, body, details, status, published_snapshot, previous_published_snapshot, published_live, created_by, updated_by, created_at, updated_at";

/** Same shape from the items_live view (what Readers and agents see). */
export const LIVE_ITEM_COLUMNS =
  "id, library_id, name, entity_key, labels, aliases, summary, body, details, status, published_snapshot, previous_published_snapshot, has_pending_changes, created_by, updated_by, created_at, updated_at";

/**
 * Readers always read items_live: a Pending edit on a live item shows its
 * published copy there, so draft text cannot reach them. Editors read the
 * working row unless they ask for the live view (MCP default).
 */
export function readsLive(scope: { publishedOnly: boolean; live?: boolean }): boolean {
  return scope.publishedOnly || scope.live === true;
}

export function itemSource(scope: { publishedOnly: boolean; live?: boolean }): string {
  return readsLive(scope) ? "items_live" : "items";
}

export function itemColumns(scope: { publishedOnly: boolean; live?: boolean }): string {
  return readsLive(scope) ? LIVE_ITEM_COLUMNS : ITEM_COLUMNS;
}

/** Hard caps so callers cannot ask Postgres for unbounded pages. */
export const LIST_LIMIT_MAX = 200;
export const LIST_OFFSET_MAX = 10_000;

/** Labels may arrive as JSON text or a parsed array (Postgres JSONB). */
export function parseLabels(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export function asStatus(value: string): ItemStatus {
  if (value === "published") return "published";
  if (value === "archived") return "archived";
  return "draft";
}

export function labelsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** True when working fields differ from the last published snapshot (same rules as Diff). */
export function itemDiffersFromSnapshot(
  item: {
    name: string;
    labels: string[];
    aliases?: string[];
    summary: string;
    body: string;
    details: string | null;
  },
  snapshot: PublishedSnapshot,
): boolean {
  return (
    item.name !== snapshot.name ||
    !labelsEqual(item.labels, snapshot.labels) ||
    !labelsEqual(item.aliases ?? [], snapshot.aliases ?? []) ||
    item.summary !== snapshot.summary ||
    item.body !== snapshot.body ||
    (item.details ?? "") !== (snapshot.details ?? "")
  );
}

/** Which snapshot Revert will restore into working fields. */
export type RevertKind = "published" | "previous";

export type RevertPlan = {
  kind: RevertKind;
  snapshot: PublishedSnapshot;
};

/**
 * Prefer the current published snapshot when working fields drifted (Pending edit).
 * If those match (e.g. right after Publish), fall back to the previous published copy.
 */
export function revertPlan(item: {
  status: ItemStatus;
  published_snapshot: PublishedSnapshot | null;
  previous_published_snapshot: PublishedSnapshot | null;
  name: string;
  labels: string[];
  aliases?: string[];
  summary: string;
  body: string;
  details: string | null;
}): RevertPlan | null {
  if (item.status === "archived") return null;
  if (item.published_snapshot && itemDiffersFromSnapshot(item, item.published_snapshot)) {
    return { kind: "published", snapshot: item.published_snapshot };
  }
  if (
    item.previous_published_snapshot &&
    itemDiffersFromSnapshot(item, item.previous_published_snapshot)
  ) {
    return { kind: "previous", snapshot: item.previous_published_snapshot };
  }
  return null;
}

/**
 * Publisher may revert working fields to a published snapshot.
 * Archived items must use Restore (un-archive) first.
 */
export function canRevertToPublished(item: {
  status: ItemStatus;
  published_snapshot: PublishedSnapshot | null;
  previous_published_snapshot: PublishedSnapshot | null;
  name: string;
  labels: string[];
  aliases?: string[];
  summary: string;
  body: string;
  details: string | null;
}): boolean {
  return revertPlan(item) !== null;
}

/**
 * When Publish or Unlock save replaces published_snapshot with different content,
 * keep the old copy as previous. Same content → leave previous as-is.
 */
export function previousSnapshotAfterPublish(
  prior: PublishedSnapshot | null,
  next: {
    name: string;
    labels: string[];
    aliases?: string[];
    summary: string;
    body: string;
    details: string | null;
  },
  existingPrevious: PublishedSnapshot | null,
): PublishedSnapshot | null {
  if (prior && itemDiffersFromSnapshot(next, prior)) return prior;
  return existingPrevious;
}

export function parsePublishedSnapshot(raw: string | null | undefined): PublishedSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.summary !== "string" || typeof row.body !== "string") {
      return null;
    }
    return {
      name: row.name,
      labels: Array.isArray(row.labels)
        ? row.labels.filter((entry): entry is string => typeof entry === "string")
        : [],
      aliases: Array.isArray(row.aliases)
        ? row.aliases.filter((entry): entry is string => typeof entry === "string")
        : [],
      summary: row.summary,
      body: row.body,
      details: typeof row.details === "string" ? row.details : null,
      published_at: typeof row.published_at === "number" ? row.published_at : 0,
    };
  } catch {
    return null;
  }
}

export function snapshotFromItem(item: {
  name: string;
  labels: string[];
  aliases?: string[];
  summary: string;
  body: string;
  details: string | null;
  published_at: number;
}): string {
  const snapshot: PublishedSnapshot = {
    name: item.name,
    labels: item.labels,
    aliases: item.aliases ?? [],
    summary: item.summary,
    body: item.body,
    details: item.details,
    published_at: item.published_at,
  };
  return JSON.stringify(snapshot);
}

export function toItem(row: SqlItem): ItemRow {
  const live = row.published_live === true || row.has_pending_changes === true;
  return {
    id: row.id,
    library_id: row.library_id,
    name: row.name,
    entity_key: typeof row.entity_key === "string" && row.entity_key ? row.entity_key : null,
    labels: parseLabels(row.labels),
    aliases: parseLabels(row.aliases ?? []),
    summary: row.summary,
    body: row.body,
    status: asStatus(row.status),
    details: row.details,
    published_snapshot: parsePublishedSnapshot(row.published_snapshot),
    previous_published_snapshot: parsePublishedSnapshot(row.previous_published_snapshot),
    has_pending_changes: live,
    view: row.has_pending_changes == null ? "working" : "live",
    policy: parsePolicyDetails(row.details),
    procedure: parseProcedureDetails(row.details),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Summary is required. Prefer the leading prose; otherwise the name. */
export function summaryFor(name: string, body: string): string {
  const lead = splitSummaryAndTable(body).summary.replace(/\s+/g, " ").trim();
  if (lead) return lead.slice(0, 500);
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat) return flat.slice(0, 500);
  return name.trim().slice(0, 500);
}

export async function allRows<T>(db: Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = await db.prepare(sql);
  return (await stmt.all(...params)) as T[];
}

export async function getRow<T>(db: Database, sql: string, ...params: unknown[]): Promise<T | undefined> {
  const stmt = await db.prepare(sql);
  return (await stmt.get(...params)) as T | undefined;
}

export async function runSql(db: Database, sql: string, ...params: unknown[]): Promise<void> {
  const stmt = await db.prepare(sql);
  await stmt.run(...params);
}

export function libraryWhere(scope: { publishedOnly: boolean }): string {
  // Two fixed clauses. The library id is always a bound parameter.
  return scope.publishedOnly ? "library_id = ? AND status = 'published'" : "library_id = ?";
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
