/** Search-then-fetch lookup: full-text candidates, then name/summary ranking. */
import type { Database } from "./types.ts";
import { excerptOf } from "../items/schema.ts";
import type { ItemRow, ItemSummary, ReadScope } from "./models.ts";
import { allRows, asStatus, libraryWhere, parseLabels } from "./query-helpers.ts";
import { getItem } from "./items.ts";
import { resolveLibrary } from "./libraries.ts";

const LOOKUP_STOP_WORDS = new Set([
  "a", "an", "the", "what", "whats", "is", "are", "was", "for", "of", "to", "in", "on", "at",
  "how", "do", "does", "me", "please", "and", "or", "with", "who", "where", "when", "which",
  "that", "this", "from", "about", "tell", "give",
]);

/**
 * English tsvector stemming ignores very short tokens; two-letter words are
 * matched on name and summary with a regex.
 */
const SEARCH_MIN_TOKEN = 3;

/** Index hits to re-rank. The rest of the library stays in the table. */
const LOOKUP_CANDIDATE_LIMIT = 25;

/** Words that identify an item. Drops filler so "what is the phone for X" can match X. */
function searchTokens(q: string): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(raw.filter((token) => token.length > 1 && !LOOKUP_STOP_WORDS.has(token)))];
}

/** Whole word, so a hit lines up with the full-text index. */
function hasWord(lowerText: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`).test(lowerText);
}

function scoreItem(row: { name: string; summary: string; body: string }, tokens: string[]): number {
  const name = row.name.toLowerCase();
  const summary = row.summary.toLowerCase();
  const body = row.body.toLowerCase();
  let score = 0;
  let nameHits = 0;
  for (const token of tokens) {
    if (hasWord(name, token)) {
      score += 8;
      nameHits += 1;
    } else if (hasWord(summary, token)) {
      score += 3;
    } else if (token.length >= SEARCH_MIN_TOKEN && hasWord(body, token)) {
      score += 1;
    }
  }
  if (tokens.length > 0 && nameHits === tokens.length) score += 10;
  return score;
}

export type LookupResult =
  | { kind: "choices"; libraries: { id: string; name: string }[] }
  | { kind: "none" }
  | { kind: "item"; item: ItemRow }
  | { kind: "list"; items: ItemSummary[] };

/** Columns the index search returns. Body is filled in only for the short candidate list. */
type LookupHit = {
  id: string;
  library_id: string;
  name: string;
  entity_key: string | null;
  labels: string | string[];
  summary: string;
  body: string;
  status: string;
  updated_at: number;
};

type RankedHit = { hit: LookupHit; score: number };

function searchPhrase(tokens: string[]): string {
  return tokens.filter((token) => token.length >= SEARCH_MIN_TOKEN).join(" ");
}

function rankHits(hits: LookupHit[], tokens: string[]): RankedHit[] {
  return hits
    .map((hit) => ({ hit, score: scoreItem(hit, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.hit.updated_at - a.hit.updated_at);
}

function isClearWinner(ranked: RankedHit[]): boolean {
  const best = ranked[0];
  if (!best) return false;
  const second = ranked[1]?.score ?? 0;
  return ranked.length === 1 || best.score >= second + 4;
}

/**
 * A body-only hit scores at most one point per word, and the next name hit
 * can pick up those same points. Skip the body search when that cannot
 * close the gap of 4 that makes a clear winner.
 */
function nameIsEnough(ranked: RankedHit[], tokenCount: number): boolean {
  const best = ranked[0];
  if (!best || tokenCount === 0) return false;
  const second = ranked[1]?.score ?? 0;
  const rival = Math.max(second + tokenCount, tokenCount);
  return best.score >= rival + 4;
}

function mergeHits(groups: LookupHit[][]): LookupHit[] {
  const byId = new Map<string, LookupHit>();
  for (const hit of groups.flat()) {
    const existing = byId.get(hit.id);
    if (!existing || hit.body.length > existing.body.length) byId.set(hit.id, hit);
  }
  return [...byId.values()];
}

function summaryFromHit(hit: LookupHit): ItemSummary {
  return {
    id: hit.id,
    library_id: hit.library_id,
    name: hit.name,
    entity_key: hit.entity_key ?? null,
    labels: parseLabels(hit.labels),
    summary: excerptOf(hit.summary),
    status: asStatus(hit.status),
    updated_at: hit.updated_at,
  };
}

async function findNameSummaryHits(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  phrase: string,
  shortTokens: string[],
): Promise<LookupHit[]> {
  const groups: LookupHit[][] = [];
  if (phrase) {
    // Use the stored search_tsv index. Body-only hits score 0 in JS when body
    // is left empty here, so this pass stays name/summary-focused.
    const rows = await allRows<Omit<LookupHit, "body"> & { relevance: number }>(
      db,
      `SELECT id, library_id, name, entity_key, labels, summary, status, updated_at,
              ts_rank(search_tsv, plainto_tsquery('english', ?)) AS relevance
       FROM items
       WHERE ${libraryWhere(scope)}
         AND search_tsv @@ plainto_tsquery('english', ?)
       ORDER BY relevance DESC, updated_at DESC
       LIMIT ${LOOKUP_CANDIDATE_LIMIT}`,
      phrase,
      libraryId,
      phrase,
    );
    groups.push(rows.map((row) => ({ ...row, body: "" })));
  }
  const safeShort = shortTokens.filter((token) => /^[a-z0-9]{2}$/.test(token));
  if (safeShort.length > 0) {
    // Bound as a parameter. Tokens are two letters or digits, so the pattern
    // cannot change the SQL or carry a regex operator from the question.
    const pattern = `(^|[^a-z0-9])(${safeShort.join("|")})([^a-z0-9]|$)`;
    const rows = await allRows<Omit<LookupHit, "body">>(
      db,
      `SELECT id, library_id, name, entity_key, labels, summary, status, updated_at
       FROM items
       WHERE ${libraryWhere(scope)}
         AND (LOWER(name) ~ ? OR LOWER(summary) ~ ?)
       ORDER BY updated_at DESC
       LIMIT ${LOOKUP_CANDIDATE_LIMIT}`,
      libraryId,
      pattern,
      pattern,
    );
    groups.push(rows.map((row) => ({ ...row, body: "" })));
  }
  return mergeHits(groups);
}

async function findBodyHitIds(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  phrase: string,
): Promise<string[]> {
  if (!phrase) return [];
  const rows = await allRows<{ id: string }>(
    db,
    `SELECT id
     FROM items
     WHERE ${libraryWhere(scope)}
       AND search_tsv @@ plainto_tsquery('english', ?)
     ORDER BY ts_rank(search_tsv, plainto_tsquery('english', ?)) DESC, updated_at DESC
     LIMIT ${LOOKUP_CANDIDATE_LIMIT}`,
    libraryId,
    phrase,
    phrase,
  );
  return rows.map((row) => row.id);
}

async function loadLookupHits(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  ids: string[],
): Promise<LookupHit[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return allRows<LookupHit>(
    db,
    `SELECT id, library_id, name, entity_key, labels, summary, body, status, updated_at
     FROM items
     WHERE ${libraryWhere(scope)}
       AND id IN (${placeholders})`,
    libraryId,
    ...ids,
  );
}

/**
 * One library, one question. A clear match returns the full item so the agent
 * does not need a second call. A tie returns a few summaries.
 *
 * The database full-text index finds the candidate rows. Name and summary
 * are searched first. The body is read only for that short list, or for the
 * one item that is returned.
 */
export async function lookupItems(
  db: Database,
  query: { library_id?: string; library_name?: string; q: string },
  scope: ReadScope = { publishedOnly: true },
): Promise<LookupResult> {
  const library = await resolveLibrary(db, query);
  if (!library) return { kind: "none" };
  if ("choices" in library) return { kind: "choices", libraries: library.choices };

  // Cap question length even if a caller skipped the Zod schema.
  const tokens = searchTokens(query.q.slice(0, 200));
  if (tokens.length === 0) return { kind: "none" };
  const phrase = searchPhrase(tokens);
  const shortTokens = tokens.filter((token) => token.length < SEARCH_MIN_TOKEN);
  const openScope = { publishedOnly: scope.publishedOnly, libraryId: library.id };

  const nameHits = await findNameSummaryHits(db, library.id, scope, phrase, shortTokens);
  const rankedNames = rankHits(nameHits, tokens);
  const leading = rankedNames[0];
  if (leading && nameIsEnough(rankedNames, tokens.length)) {
    const item = await getItem(db, leading.hit.id, openScope);
    if (item) return { kind: "item", item };
  }

  const ids = new Set(nameHits.map((hit) => hit.id));
  for (const id of await findBodyHitIds(db, library.id, scope, phrase)) ids.add(id);
  if (ids.size === 0) return { kind: "none" };

  const ranked = rankHits(await loadLookupHits(db, library.id, scope, [...ids]), tokens);
  const winner = ranked[0];
  if (!winner) return { kind: "none" };
  if (!isClearWinner(ranked)) {
    return { kind: "list", items: ranked.slice(0, 5).map((entry) => summaryFromHit(entry.hit)) };
  }
  const item = await getItem(db, winner.hit.id, openScope);
  return item ? { kind: "item", item } : { kind: "none" };
}
