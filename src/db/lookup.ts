/** Search-then-fetch lookup: full-text candidates, then name/summary ranking. */
import type { Database } from "./types.ts";
import { excerptOf } from "../items/schema.ts";
import type { ItemRow, ItemSummary, ReadScope } from "./models.ts";
import { allRows, asStatus, itemSource, libraryWhere, parseLabels } from "./query-helpers.ts";
import { getItem } from "./items.ts";
import { resolveLibrary } from "./libraries.ts";

const LOOKUP_STOP_WORDS = new Set([
  "a", "an", "the", "what", "whats", "is", "are", "was", "for", "of", "to", "in", "on", "at",
  "how", "do", "does", "me", "please", "and", "or", "with", "who", "where", "when", "which",
  "that", "this", "from", "about", "tell", "give",
  // Conversational filler. Without these an OR fallback matches on noise.
  "i", "im", "my", "we", "our", "you", "your", "it", "its", "be", "am", "can", "will", "should",
  "would", "could", "if", "they", "them", "their", "there", "get", "got", "keep", "keeps", "why",
  "think", "need", "want", "know", "happens", "happen", "any", "some", "just", "still", "has",
  "have", "had", "did", "been", "so", "then", "than", "into", "onto", "not", "no", "yes",
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

/** Crude English stem so "graded"/"grading" and "locked"/"lockout" line up in JS ranking. */
function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(ations?|ings?|edly|ed|es|s|er|ly)$/, "") || word;
}

function words(lowerText: string): string[] {
  return lowerText.match(/[a-z0-9]+/g) ?? [];
}

/** Word hit, or the same crude stem (3+ letters) as a word in the text. */
function matchesWord(lowerText: string, token: string): boolean {
  if (hasWord(lowerText, token)) return true;
  // A long word that starts another word: "trouble" → "troubleshooting".
  if (token.length >= 5 && words(lowerText).some((word) => word.length > token.length && word.startsWith(token))) {
    return true;
  }
  const target = stem(token);
  if (target.length < 3) return false;
  return words(lowerText).some((word) => word.length >= 3 && stem(word) === target);
}

type Scored = {
  score: number;
  nameHits: number;
  labelHits: number;
  strongHits: number;
  /** Words found in the labels, whether or not the name also had them. */
  labelCover: number;
};

function scoreDetail(
  row: { name: string; summary: string; body: string; labels?: string | string[] },
  tokens: string[],
): Scored {
  const name = row.name.toLowerCase();
  const summary = row.summary.toLowerCase();
  const body = row.body.toLowerCase();
  const labels = parseLabels(row.labels ?? []).join(" ").toLowerCase();
  let score = 0;
  let nameHits = 0;
  let labelHits = 0;
  let strongHits = 0;
  let labelCover = 0;
  for (const token of tokens) {
    if (labels && matchesWord(labels, token)) labelCover += 1;
    if (matchesWord(name, token)) {
      score += 8;
      nameHits += 1;
      strongHits += 1;
    } else if (labels && matchesWord(labels, token)) {
      score += 4;
      labelHits += 1;
      strongHits += 1;
    } else if (matchesWord(summary, token)) {
      score += 3;
      strongHits += 1;
    } else if (token.length >= SEARCH_MIN_TOKEN && matchesWord(body, token)) {
      score += 1;
    }
  }
  if (tokens.length > 0 && nameHits === tokens.length) score += 10;
  return { score, nameHits, labelHits, strongHits, labelCover };
}

function scoreItem(
  row: { name: string; summary: string; body: string; labels?: string | string[] },
  tokens: string[],
): number {
  return scoreDetail(row, tokens).score;
}

export type LookupResult =
  | { kind: "choices"; libraries: { id: string; name: string }[] }
  | { kind: "none" }
  /** corrected: the spelling the match was found with, when a word was corrected. */
  | { kind: "item"; item: ItemRow; corrected?: string }
  | { kind: "list"; items: ItemSummary[] }
  /**
   * No item matched every word. These are close candidates (some words, or a
   * corrected spelling). The agent must open one and check it answers the
   * question before citing, or say it is not in the library.
   */
  | { kind: "suggest"; items: ItemSummary[]; corrected?: string };

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
       FROM ${itemSource(scope)}
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
       FROM ${itemSource(scope)}
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
     FROM ${itemSource(scope)}
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
     FROM ${itemSource(scope)}
     WHERE ${libraryWhere(scope)}
       AND id IN (${placeholders})`,
    libraryId,
    ...ids,
  );
}

/** Library item rows whose labels contain every token (all = true) or any token. */
async function findLabelHits(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
  all: boolean,
): Promise<LookupHit[]> {
  const safe = tokens.filter((token) => /^[a-z0-9]{2,40}$/.test(token));
  if (safe.length === 0) return [];
  // Tokens are letters and digits only, so the patterns cannot carry a regex
  // operator from the question. Each pattern is a bound parameter.
  const patterns = all
    ? safe.map((token) => `(^|[^a-z0-9])${token}([^a-z0-9]|$)`)
    : [`(^|[^a-z0-9])(${safe.join("|")})([^a-z0-9]|$)`];
  const where = patterns.map(() => "LOWER(labels::text) ~ ?").join(all ? " AND " : " OR ");
  const rows = await allRows<Omit<LookupHit, "body">>(
    db,
    `SELECT id, library_id, name, entity_key, labels, summary, status, updated_at
     FROM ${itemSource(scope)}
     WHERE ${libraryWhere(scope)}
       AND (${where})
     ORDER BY updated_at DESC
     LIMIT ${LOOKUP_CANDIDATE_LIMIT}`,
    libraryId,
    ...patterns,
  );
  return rows.map((row) => ({ ...row, body: "" }));
}

/** Full-text hits on ANY of the words (the AND pass found nothing). */
async function findAnyWordHitIds(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
): Promise<string[]> {
  const usable = tokens.filter((token) => token.length >= SEARCH_MIN_TOKEN && /^[a-z0-9]+$/.test(token));
  if (usable.length === 0) return [];
  // to_tsquery syntax built from [a-z0-9] words only, joined with OR.
  const orQuery = usable.join(" | ");
  const rows = await allRows<{ id: string }>(
    db,
    `SELECT id
     FROM ${itemSource(scope)}
     WHERE ${libraryWhere(scope)}
       AND search_tsv @@ to_tsquery('english', ?)
     ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', ?)) DESC, updated_at DESC
     LIMIT ${LOOKUP_CANDIDATE_LIMIT}`,
    libraryId,
    orQuery,
    orQuery,
  );
  return rows.map((row) => row.id);
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), capped. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const prev = rows[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = value;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/** Words allowed for spelling correction: names, summaries and labels of this library. */
const VOCABULARY_ROW_LIMIT = 2000;

async function libraryVocabulary(db: Database, libraryId: string, scope: ReadScope): Promise<Set<string>> {
  const rows = await allRows<{ name: string; summary: string; labels: string | string[] }>(
    db,
    `SELECT name, summary, labels
     FROM ${itemSource(scope)}
     WHERE ${libraryWhere(scope)}
     ORDER BY updated_at DESC
     LIMIT ${VOCABULARY_ROW_LIMIT}`,
    libraryId,
  );
  const vocabulary = new Set<string>();
  for (const row of rows) {
    const text = `${row.name} ${row.summary} ${parseLabels(row.labels).join(" ")}`.toLowerCase();
    for (const word of words(text)) if (word.length >= 3) vocabulary.add(word);
  }
  return vocabulary;
}

/**
 * Replace words that appear nowhere in the library with the closest word that
 * does (1 edit for words up to 4 letters, 2 for longer). Returns undefined
 * when nothing changed.
 */
async function correctTokens(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
): Promise<string[] | undefined> {
  const vocabulary = await libraryVocabulary(db, libraryId, scope);
  let changed = false;
  const out = tokens.map((token) => {
    if (token.length < 3 || /^\d+$/.test(token) || vocabulary.has(token)) return token;
    const limit = token.length <= 4 ? 1 : 2;
    let best: string | undefined;
    let bestDistance = limit + 1;
    for (const word of vocabulary) {
      if (Math.abs(word.length - token.length) > limit) continue;
      const distance = editDistance(token, word, limit);
      if (distance < bestDistance) {
        best = word;
        bestDistance = distance;
      }
    }
    if (best && bestDistance <= limit) {
      changed = true;
      return best;
    }
    return token;
  });
  return changed ? out : undefined;
}

type Ranked = { hit: LookupHit; detail: Scored };

function rankDetailed(hits: LookupHit[], tokens: string[]): Ranked[] {
  return hits
    .map((hit) => ({ hit, detail: scoreDetail(hit, tokens) }))
    .filter((entry) => entry.detail.score > 0)
    .sort((a, b) => b.detail.score - a.detail.score || b.hit.updated_at - a.hit.updated_at);
}

/**
 * A category question ("runbook") names a label that several items share.
 * Picking one of them as "the" answer would be a confident wrong answer.
 */
function labelCategory(ranked: Ranked[], tokens: string[]): Ranked[] {
  return ranked.filter((entry) => entry.detail.labelCover === tokens.length);
}

function summaries(entries: Ranked[]): ItemSummary[] {
  return entries.slice(0, 5).map((entry) => summaryFromHit(entry.hit));
}

/** Every word must match (the original lookup), with labels considered. */
async function lookupAllWords(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
): Promise<{ kind: "item"; id: string } | { kind: "list"; items: ItemSummary[] } | { kind: "none" }> {
  const phrase = searchPhrase(tokens);
  const shortTokens = tokens.filter((token) => token.length < SEARCH_MIN_TOKEN);
  const nameHits = mergeHits([
    await findNameSummaryHits(db, libraryId, scope, phrase, shortTokens),
    await findLabelHits(db, libraryId, scope, tokens, true),
  ]);
  const rankedNames = rankHits(nameHits, tokens);
  const leading = rankedNames[0];
  const ids = new Set(nameHits.map((hit) => hit.id));
  if (!(leading && nameIsEnough(rankedNames, tokens.length))) {
    for (const id of await findBodyHitIds(db, libraryId, scope, phrase)) ids.add(id);
  }
  if (ids.size === 0) return { kind: "none" };

  const ranked = rankDetailed(await loadLookupHits(db, libraryId, scope, [...ids]), tokens);
  const winner = ranked[0];
  if (!winner) return { kind: "none" };
  const category = labelCategory(ranked, tokens);
  if (category.length >= 2) return { kind: "list", items: summaries(category) };
  const second = ranked[1]?.detail.score ?? 0;
  if (ranked.length === 1 || winner.detail.score >= second + 4) return { kind: "item", id: winner.hit.id };
  return { kind: "list", items: summaries(ranked) };
}

/**
 * Some of the words match. A single answer needs a clear winner that matched
 * on its name or labels; anything weaker is offered as "did you mean".
 */
async function lookupAnyWord(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
): Promise<{ kind: "item"; id: string } | { kind: "suggest"; items: ItemSummary[] } | { kind: "none" }> {
  const ids = new Set<string>();
  for (const hit of await findLabelHits(db, libraryId, scope, tokens, false)) ids.add(hit.id);
  for (const id of await findAnyWordHitIds(db, libraryId, scope, tokens)) ids.add(id);
  if (ids.size === 0) return { kind: "none" };
  const ranked = rankDetailed(await loadLookupHits(db, libraryId, scope, [...ids]), tokens).filter(
    // A lone body word is noise; keep items that matched on name, label or
    // summary, or on several body words.
    (entry) => entry.detail.strongHits > 0 || entry.detail.score >= 2,
  );
  const winner = ranked[0];
  if (!winner) return { kind: "none" };
  const second = ranked[1]?.detail.score ?? 0;
  const anchored = winner.detail.nameHits + winner.detail.labelHits > 0;
  // More than half the words must land on the name, labels or summary: "cell
  // membrane" should not confidently return a lesson that never mentions membranes.
  const covers = winner.detail.strongHits * 2 > tokens.length;
  if (anchored && covers && winner.detail.score >= 8 && winner.detail.score >= second + 4) {
    return { kind: "item", id: winner.hit.id };
  }
  return { kind: "suggest", items: summaries(ranked) };
}

async function lookupTokens(
  db: Database,
  libraryId: string,
  scope: ReadScope,
  tokens: string[],
): Promise<{ kind: "item"; id: string } | { kind: "list" | "suggest"; items: ItemSummary[] } | { kind: "none" }> {
  const all = await lookupAllWords(db, libraryId, scope, tokens);
  if (all.kind !== "none") return all;
  return lookupAnyWord(db, libraryId, scope, tokens);
}

/**
 * One library, one question. A clear match returns the full item so the agent
 * does not need a second call. A tie returns a few summaries.
 *
 * 1. Every word must match (name, labels, summary, then body).
 * 2. Otherwise any word may match. A clear winner on its name or labels is
 *    returned; weaker candidates come back as "suggest" (did you mean).
 * 3. Otherwise words that appear nowhere in the library are corrected to the
 *    closest library word (typos) and steps 1–2 run again.
 * Nothing close: "none", so the agent says the library does not cover it.
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
  const openScope = { publishedOnly: scope.publishedOnly, live: scope.live, libraryId: library.id };

  const open = async (id: string, corrected?: string): Promise<LookupResult> => {
    const item = await getItem(db, id, openScope);
    if (!item) return { kind: "none" };
    return corrected ? { kind: "item", item, corrected } : { kind: "item", item };
  };

  const direct = await lookupTokens(db, library.id, scope, tokens);
  if (direct.kind === "item") return open(direct.id);
  if (direct.kind === "list") return { kind: "list", items: direct.items };

  const corrected = await correctTokens(db, library.id, scope, tokens);
  if (corrected) {
    const again = await lookupTokens(db, library.id, scope, corrected);
    const spelled = corrected.join(" ");
    if (again.kind === "item") return open(again.id, spelled);
    if (again.kind === "list" || again.kind === "suggest") {
      return { kind: "suggest", items: again.items, corrected: spelled };
    }
  }
  if (direct.kind === "suggest") return direct;
  return { kind: "none" };
}
