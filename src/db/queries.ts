import type { Database } from "./types.ts";
import { excerptOf, type ItemInput, type ListQuery } from "../items/schema.ts";
import {
  parsePolicyDetails,
  parseProcedureDetails,
  type LibraryTemplate,
  type PolicyDetails,
  type ProcedureDetails,
} from "../items/templates.ts";
import { splitSummaryAndTable } from "../markdown/table.ts";

export type LibraryRow = {
  id: string;
  name: string;
  template: LibraryTemplate;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type ItemStatus = "draft" | "published";

/** App-facing item. Columns on disk are name, labels, summary, body, status. */
export type ItemRow = {
  id: string;
  library_id: string;
  name: string;
  labels: string[];
  summary: string;
  body: string;
  status: ItemStatus;
  policy?: PolicyDetails;
  procedure?: ProcedureDetails;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

/** @deprecated Use ItemRow. */
export type RecordRow = ItemRow;

export type ItemSummary = {
  id: string;
  library_id: string;
  name: string;
  labels: string[];
  summary: string;
  updated_at: number;
};

/** @deprecated Use ItemSummary. */
export type RecordSummary = ItemSummary;

export type AuditRow = {
  id: string;
  actor_sub: string;
  tool: string;
  success: boolean;
  detail: string;
  created_at: number;
};

type SqlItem = {
  id: string;
  library_id: string;
  name: string;
  labels: string;
  summary: string;
  body: string;
  details: string | null;
  status: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type ReadScope = {
  /** Reader path: only status = 'published'. Editors pass false and can see drafts. */
  publishedOnly: boolean;
};

function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function asStatus(value: string): ItemStatus {
  return value === "published" ? "published" : "draft";
}

function toItem(row: SqlItem): ItemRow {
  return {
    id: row.id,
    library_id: row.library_id,
    name: row.name,
    labels: parseLabels(row.labels),
    summary: row.summary,
    body: row.body,
    status: asStatus(row.status),
    policy: parsePolicyDetails(row.details),
    procedure: parseProcedureDetails(row.details),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Summary is required. Prefer the leading prose; otherwise the name. */
function summaryFor(name: string, body: string): string {
  const lead = splitSummaryAndTable(body).summary.replace(/\s+/g, " ").trim();
  if (lead) return lead.slice(0, 500);
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat) return flat.slice(0, 500);
  return name.trim().slice(0, 500);
}

async function allRows<T>(db: Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = await db.prepare(sql);
  return (await stmt.all(...params)) as T[];
}

async function getRow<T>(db: Database, sql: string, ...params: unknown[]): Promise<T | undefined> {
  const stmt = await db.prepare(sql);
  return (await stmt.get(...params)) as T | undefined;
}

async function runSql(db: Database, sql: string, ...params: unknown[]): Promise<void> {
  const stmt = await db.prepare(sql);
  await stmt.run(...params);
}

function libraryTemplate(value: string | undefined): LibraryTemplate {
  if (value === "policy" || value === "procedure") return value;
  return "general";
}

export async function listLibraries(db: Database): Promise<LibraryRow[]> {
  // utf8mb4_unicode_ci is case-insensitive, so name order matches the old NOCASE sort.
  const rows = await allRows<LibraryRow & { template?: string }>(
    db,
    "SELECT * FROM libraries ORDER BY name ASC",
  );
  return rows.map((row) => ({
    ...row,
    template: libraryTemplate(row.template),
  }));
}

export async function getLibrary(db: Database, id: string): Promise<LibraryRow | undefined> {
  const row = await getRow<LibraryRow & { template?: string }>(db, "SELECT * FROM libraries WHERE id = ?", id);
  if (!row) return undefined;
  return { ...row, template: libraryTemplate(row.template) };
}

export async function createLibrary(
  db: Database,
  name: string,
  actorSub: string,
  template: LibraryTemplate = "general",
): Promise<LibraryRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  await runSql(
    db,
    `INSERT INTO libraries (id, name, template, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    name.trim(),
    template,
    actorSub,
    actorSub,
    now,
    now,
  );
  const created = await getLibrary(db, id);
  if (!created) throw new Error("failed to read library after insert");
  return created;
}

const LOOKUP_STOP_WORDS = new Set([
  "a", "an", "the", "what", "whats", "is", "are", "was", "for", "of", "to", "in", "on", "at",
  "how", "do", "does", "me", "please", "and", "or", "with", "who", "where", "when", "which",
  "that", "this", "from", "about", "tell", "give",
]);

/**
 * InnoDB full-text ignores words shorter than innodb_ft_min_token_size.
 * The server default is 3. Two-letter words are matched on name and summary only.
 */
const FULLTEXT_MIN_TOKEN = 3;

/** Index hits to re-rank. The rest of the library stays in the table. */
const LOOKUP_CANDIDATE_LIMIT = 25;

/** Words that identify an item. Drops filler so "what is the phone for X" can match X. */
function searchTokens(q: string): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(raw.filter((token) => token.length > 1 && !LOOKUP_STOP_WORDS.has(token)))];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
    } else if (token.length >= FULLTEXT_MIN_TOKEN && hasWord(body, token)) {
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
  labels: string;
  summary: string;
  body: string;
  updated_at: number;
};

type RankedHit = { hit: LookupHit; score: number };

function libraryWhere(scope: ReadScope): string {
  // Two fixed clauses. The library id is always a bound parameter.
  return scope.publishedOnly ? "library_id = ? AND status = 'published'" : "library_id = ?";
}

function fulltextPhrase(tokens: string[]): string {
  return tokens.filter((token) => token.length >= FULLTEXT_MIN_TOKEN).join(" ");
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
    labels: parseLabels(hit.labels),
    summary: excerptOf(hit.summary),
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
    const rows = await allRows<Omit<LookupHit, "body"> & { relevance: number }>(
      db,
      `SELECT id, library_id, name, labels, summary, updated_at,
              MATCH(name, summary) AGAINST (? IN BOOLEAN MODE) AS relevance
       FROM items
       WHERE ${libraryWhere(scope)}
         AND MATCH(name, summary) AGAINST (? IN BOOLEAN MODE)
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
      `SELECT id, library_id, name, labels, summary, updated_at
       FROM items
       WHERE ${libraryWhere(scope)}
         AND (LOWER(name) REGEXP ? OR LOWER(summary) REGEXP ?)
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
       AND MATCH(body) AGAINST (? IN BOOLEAN MODE)
     ORDER BY MATCH(body) AGAINST (? IN BOOLEAN MODE) DESC, updated_at DESC
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
    `SELECT id, library_id, name, labels, summary, body, updated_at
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

  const tokens = searchTokens(query.q);
  if (tokens.length === 0) return { kind: "none" };
  const phrase = fulltextPhrase(tokens);
  const shortTokens = tokens.filter((token) => token.length < FULLTEXT_MIN_TOKEN);
  const openScope = scope.publishedOnly
    ? { publishedOnly: true as const, libraryId: library.id }
    : { publishedOnly: false as const };

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

/** Exact library name wins. A partial name is used only when it matches one library. */
async function resolveLibrary(
  db: Database,
  input: { library_id?: string; library_name?: string },
): Promise<{ id: string } | { choices: { id: string; name: string }[] } | undefined> {
  if (input.library_id) {
    const row = await getLibrary(db, input.library_id);
    return row ? { id: row.id } : undefined;
  }
  const name = input.library_name?.trim();
  if (!name) return undefined;
  const exact = await allRows<{ id: string; name: string }>(
    db,
    "SELECT id, name FROM libraries WHERE name = ?",
    name,
  );
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { choices: exact };
  const partial = await allRows<{ id: string; name: string }>(
    db,
    // JavaScript and MariaDB each treat backslash as an escape, so four
    // slashes here become the single ESCAPE '\' character.
    "SELECT id, name FROM libraries WHERE name LIKE ? ESCAPE '\\\\' ORDER BY name ASC",
    `%${escapeLike(name)}%`,
  );
  if (partial.length === 1) return { id: partial[0].id };
  if (partial.length > 1) return { choices: partial };
  return undefined;
}

export async function defaultLibraryId(db: Database): Promise<string> {
  const row = await getRow<{ id: string }>(db, "SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1");
  if (!row) throw new Error("no libraries exist");
  return row.id;
}

export async function listItems(
  db: Database,
  query: ListQuery = {},
  scope: ReadScope = { publishedOnly: true },
): Promise<ItemSummary[]> {
  if (!query.library_id) {
    throw new Error("library_id is required");
  }
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  // Name, labels, and summary only. The body stays in the table.
  const where = [libraryWhere(scope)];
  const params: unknown[] = [query.library_id];
  const label = query.label?.trim().toLowerCase();
  if (label) {
    where.push("JSON_CONTAINS(labels, JSON_QUOTE(?))");
    params.push(label);
  }
  const needle = query.q?.trim();
  if (needle) {
    const pattern = `%${escapeLike(needle)}%`;
    where.push(
      "(name LIKE ? ESCAPE '\\\\' OR summary LIKE ? ESCAPE '\\\\' OR labels LIKE ? ESCAPE '\\\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  params.push(limit, offset);
  const rows = await allRows<Omit<LookupHit, "body">>(
    db,
    `SELECT id, library_id, name, labels, summary, updated_at
     FROM items
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
  );
  return rows.map((row) => summaryFromHit({ ...row, body: "" }));
}

/** @deprecated Use listItems. */
export const listRecords = listItems;

export async function getItem(
  db: Database,
  id: string,
  scope: ReadScope & { libraryId?: string } = { publishedOnly: true },
): Promise<ItemRow | undefined> {
  if (scope.publishedOnly && !scope.libraryId) {
    throw new Error("library_id is required");
  }
  const row = scope.publishedOnly
    ? await getRow<SqlItem>(
        db,
        "SELECT * FROM items WHERE id = ? AND library_id = ? AND status = 'published'",
        id,
        scope.libraryId,
      )
    : await getRow<SqlItem>(db, "SELECT * FROM items WHERE id = ?", id);
  return row ? toItem(row) : undefined;
}

/** @deprecated Use getItem. */
export const getRecord = getItem;

type ItemSave = ItemInput & { summary?: string; details?: string | null };

export async function createItem(
  db: Database,
  input: ItemSave,
  actorSub: string,
  libraryId?: string,
): Promise<ItemRow> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const library_id = libraryId || (await defaultLibraryId(db));
  if (!library_id) throw new Error("library_id is required");
  await runSql(
    db,
    `INSERT INTO items (
       id, library_id, name, labels, summary, body, details, status,
       created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    id,
    library_id,
    input.name,
    JSON.stringify(input.labels),
    input.summary?.trim() || summaryFor(input.name, input.body),
    input.body,
    input.details ?? null,
    actorSub,
    actorSub,
    now,
    now,
  );
  const created = await getItem(db, id, { publishedOnly: false });
  if (!created) throw new Error("failed to read item after insert");
  return created;
}

/** @deprecated Use createItem. */
export const createRecord = createItem;

export async function updateItem(
  db: Database,
  id: string,
  input: ItemSave,
  actorSub: string,
): Promise<ItemRow | undefined> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing) return undefined;
  const now = Date.now();
  await runSql(
    db,
    `UPDATE items
     SET name = ?, labels = ?, summary = ?, body = ?, details = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    input.name,
    JSON.stringify(input.labels),
    input.summary?.trim() || summaryFor(input.name, input.body),
    input.body,
    input.details ?? null,
    actorSub,
    now,
    id,
  );
  return getItem(db, id, { publishedOnly: false });
}

/** @deprecated Use updateItem. */
export const updateRecord = updateItem;

/**
 * Remove one library and the items in it.
 * publish_audit rows go first because they point at both the library and the items.
 * The notes table (records) is left in place.
 * The last library stays, so the app always has one.
 */
export async function deleteLibrary(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existing = await getRow<{ id: string }>(tx, "SELECT id FROM libraries WHERE id = ?", id);
    if (!existing) return false;
    const count = await getRow<{ n: number }>(tx, "SELECT COUNT(*) AS n FROM libraries");
    if (Number(count?.n ?? 0) <= 1) {
      throw new Error("Keep at least one library");
    }
    await runSql(tx, "DELETE FROM publish_audit WHERE library_id = ?", id);
    await runSql(tx, "DELETE FROM items WHERE library_id = ?", id);
    await runSql(tx, "DELETE FROM libraries WHERE id = ?", id);
    return true;
  });
}

export async function deleteItem(db: Database, id: string): Promise<boolean> {
  const existing = await getItem(db, id, { publishedOnly: false });
  if (!existing) return false;
  await runSql(db, "DELETE FROM items WHERE id = ?", id);
  return true;
}

/** @deprecated Use deleteItem. */
export const deleteRecord = deleteItem;

export async function writeAudit(
  db: Database,
  event: { actorSub: string; tool: string; success: boolean; detail?: string },
): Promise<void> {
  await runSql(
    db,
    `INSERT INTO audit_events (id, actor_sub, tool, success, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    event.actorSub,
    event.tool,
    event.success ? 1 : 0,
    event.detail ?? "",
    Date.now(),
  );
}

export async function listAudit(db: Database, limit = 50): Promise<AuditRow[]> {
  const rows = await allRows<{
    id: string;
    actor_sub: string;
    tool: string;
    success: number;
    detail: string;
    created_at: number;
  }>(db, "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", limit);
  return rows.map((row) => ({
    id: row.id,
    actor_sub: row.actor_sub,
    tool: row.tool,
    success: Number(row.success) === 1,
    detail: row.detail,
    created_at: row.created_at,
  }));
}
