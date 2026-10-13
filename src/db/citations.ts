/**
 * Citation handles for agent answers: which published version, when, by whom,
 * and where a person can open it. Always describes the published copy (what
 * Readers see), never a Pending draft.
 */
import type { Database } from "./types.ts";
import { allRows } from "./query-helpers.ts";

export type Citation = {
  version: number;
  published_at: string;
  updated_at: string;
  published_by: string | null;
  url: string | null;
  cite_as: string;
};

type CitationRow = {
  id: string;
  name: string;
  library_name: string;
  published_version: number | string;
  published_by_name: string | null;
  published_snapshot: string | null;
  live_updated_at: number | string;
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

function snapshotPublishedAt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  try {
    const value = (JSON.parse(raw) as { published_at?: unknown }).published_at;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Item page a person can open. Agents are told to quote it; Readers may need to sign in. */
export function itemUrl(publicBaseUrl: string | undefined, id: string): string | null {
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl.replace(/\/$/, "")}/items/${id}`;
}

/**
 * Citations for published items, keyed by id. Items that were never published
 * have no entry: a draft is not something to cite.
 */
export async function citationsFor(
  db: Database,
  ids: string[],
  publicBaseUrl?: string,
): Promise<Map<string, Citation>> {
  const out = new Map<string, Citation>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await allRows<CitationRow>(
    db,
    `SELECT live.id, live.name, l.name AS library_name, i.published_version,
            a.username AS published_by_name, i.published_snapshot,
            live.updated_at AS live_updated_at
     FROM items_live live
     JOIN items i ON i.id = live.id
     JOIN libraries l ON l.id = live.library_id
     LEFT JOIN accounts a ON a.id = i.published_by
     WHERE live.id IN (${placeholders})
       AND live.status = 'published'
       AND i.published_snapshot IS NOT NULL`,
    ...unique,
  );
  for (const row of rows) {
    const version = Number(row.published_version) || 1;
    const liveUpdated = Number(row.live_updated_at);
    const publishedAt = snapshotPublishedAt(row.published_snapshot) ?? liveUpdated;
    const url = itemUrl(publicBaseUrl, row.id);
    const day = isoDate(publishedAt).slice(0, 10);
    const by = row.published_by_name ? ` by ${row.published_by_name}` : "";
    out.set(row.id, {
      version,
      published_at: isoDate(publishedAt),
      updated_at: isoDate(Math.max(liveUpdated, publishedAt)),
      published_by: row.published_by_name,
      url,
      cite_as: `"${row.name}" (${row.library_name}), version ${version}, published ${day}${by}.${url ? ` ${url}` : ""} [item ${row.id} v${version}]`,
    });
  }
  return out;
}

/** Plain-text block appended to a full item in MCP output. */
export function citationLines(citation: Citation | undefined): string[] {
  if (!citation) return ["citation: none — this item is not published; do not cite it"];
  return [
    "citation:",
    `  version: ${citation.version}`,
    `  published_at: ${citation.published_at}`,
    `  updated_at: ${citation.updated_at}`,
    citation.published_by ? `  published_by: ${citation.published_by}` : "",
    citation.url ? `  url: ${citation.url}` : "",
    `  cite_as: ${citation.cite_as}`,
  ].filter((line) => line !== "");
}
