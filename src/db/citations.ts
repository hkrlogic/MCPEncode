/**
 * Citation handles for agent answers: which published version, when, by whom,
 * and where a person can open it. Always describes the published copy (what
 * Readers see), never a Pending draft.
 */
import type { Database } from "./types.ts";
import { isPastReview } from "./freshness.ts";
import { allRows } from "./query-helpers.ts";

export type Citation = {
  version: number;
  published_at: string;
  updated_at: string;
  published_by: string | null;
  url: string | null;
  cite_as: string;
  /** Review-by date of the published copy (YYYY-MM-DD), or null when the library does not track it. */
  review_by: string | null;
  /** True when review_by is before today: the item may be out of date. */
  stale: boolean;
  /** Who to ask: the Policy owner field, else whoever published it. */
  owner: string | null;
  /** Short line for the agent to relay to the user. Only when stale. */
  warning?: string;
  /** Set (true) only when the library refuses stale items to agents. */
  strict_freshness?: true;
  /** Revision of the working row (what update_item replaces). Internal; not sent as part of the citation. */
  revision: number;
};

/** What agents receive: the line to quote, plus review_by when set and warning when stale. */
export type CitationWire = { cite_as: string; review_by?: string; warning?: string };

type CitationRow = {
  id: string;
  name: string;
  library_name: string;
  published_version: number | string;
  published_by_name: string | null;
  published_snapshot: string | null;
  live_updated_at: number | string;
  review_by: string | null;
  strict_freshness: boolean | null;
  details: string | null;
  revision: number | string;
};

function policyOwner(details: string | null): string | null {
  if (!details) return null;
  try {
    const owner = (JSON.parse(details) as { owner?: unknown }).owner;
    return typeof owner === "string" && owner.trim() ? owner.trim() : null;
  } catch {
    return null;
  }
}

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
            live.updated_at AS live_updated_at, i.review_by::text AS review_by,
            l.strict_freshness, live.details, i.updated_at AS revision
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
    const stale = isPastReview(row.review_by);
    const owner = policyOwner(row.details) ?? row.published_by_name;
    const citation: Citation = {
      version,
      published_at: isoDate(publishedAt),
      updated_at: isoDate(Math.max(liveUpdated, publishedAt)),
      published_by: row.published_by_name,
      url,
      cite_as: `"${row.name}" (${row.library_name}), version ${version}, published ${day}${by}.${url ? ` ${url}` : ""} [item ${row.id} v${version}]`,
      review_by: row.review_by,
      stale,
      owner,
      revision: Number(row.revision),
    };
    if (stale) {
      citation.warning = `Past its review date (${row.review_by}); it may be out of date. Tell the user, and suggest checking with ${owner ?? "the library owner"}.`;
    }
    if (row.strict_freshness === true) citation.strict_freshness = true;
    out.set(row.id, citation);
  }
  return out;
}

/** Compact citation for JSON results (lists, search_shelf). */
export function citationWire(citation: Citation | undefined): CitationWire | null {
  if (!citation) return null;
  return {
    cite_as: citation.cite_as,
    ...(citation.review_by ? { review_by: citation.review_by } : {}),
    ...(citation.warning ? { warning: citation.warning } : {}),
  };
}

/**
 * Plain-text lines appended to a full item in MCP output: cite_as always,
 * review_by only when set, warning only when stale. cite_as already carries
 * the version, publish date, publisher and URL.
 */
export function citationLines(citation: Citation | undefined): string[] {
  if (!citation) return ["citation: none — this item is not published; do not cite it"];
  const wire = citationWire(citation) as CitationWire;
  return [
    `cite_as: ${wire.cite_as}`,
    ...(wire.review_by ? [`review_by: ${wire.review_by}`] : []),
    ...(wire.warning ? [`warning: ${wire.warning}`] : []),
  ];
}
