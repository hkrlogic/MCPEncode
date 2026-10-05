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
  labels: string;
  summary: string;
  body: string;
  details: string | null;
  status: string;
  published_snapshot: string | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export function parseLabels(raw: string): string[] {
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
  summary: string;
  body: string;
  details: string | null;
  published_at: number;
}): string {
  const snapshot: PublishedSnapshot = {
    name: item.name,
    labels: item.labels,
    summary: item.summary,
    body: item.body,
    details: item.details,
    published_at: item.published_at,
  };
  return JSON.stringify(snapshot);
}

export function toItem(row: SqlItem): ItemRow {
  return {
    id: row.id,
    library_id: row.library_id,
    name: row.name,
    labels: parseLabels(row.labels),
    summary: row.summary,
    body: row.body,
    status: asStatus(row.status),
    details: row.details,
    published_snapshot: parsePublishedSnapshot(row.published_snapshot),
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
