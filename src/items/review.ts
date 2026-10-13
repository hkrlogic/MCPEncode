/**
 * What a publisher reviews before Publish.
 * Short fields (Name, Labels, Summary, one-line facts) keep before and after.
 * Longer text is named on the Pending list; the item page shows the changed part.
 */
import type { LibrarySchema, SchemaFieldDef } from "./library-schema.ts";
import { parseTableValues } from "./table-proposal.ts";
import { parsePolicyDetails, parseProcedureDetails } from "./templates.ts";

export type ReviewField = {
  label: string;
  before: string;
  after: string;
  /** Longer text. The list names the field; the item page shows the changed part. */
  long: boolean;
};

export type ItemReview =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "changed"; fields: ReviewField[] };

/** Fields compared against the last published copy. */
export type ReviewSource = {
  name: string;
  labels: string[];
  aliases?: string[];
  summary: string;
  body: string;
  details: string | null;
};

const SHORT_TEXT = 400;
const LARGE_REWRITE = 800;
const CAP = 1200;
const WINDOW_PAD = 70;

function labelsText(labels: string[]): string {
  return [...labels]
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

function pushChange(
  fields: ReviewField[],
  label: string,
  before: string,
  after: string,
  long: boolean,
): void {
  if (before === after) return;
  fields.push({ label, before, after, long });
}

function detailValues(schema: LibrarySchema, raw: string | null): Record<string, string> | undefined {
  if (schema.starter === "policy") {
    const parsed = parsePolicyDetails(raw);
    return parsed ? { ...parsed } : undefined;
  }
  if (schema.starter === "procedure") {
    const parsed = parseProcedureDetails(raw);
    return parsed ? { ...parsed } : undefined;
  }
  if (schema.starter === "table") return parseTableValues(raw);
  return undefined;
}

/** Schema fields, plus any stored keys the schema does not name yet. */
function fieldDefs(
  schema: LibrarySchema,
  before: Record<string, string>,
  after: Record<string, string>,
): SchemaFieldDef[] {
  const known = new Set(schema.fields.map((field) => field.key));
  const extra = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !known.has(key))
    .sort((a, b) => a.localeCompare(b))
    .map(
      (key): SchemaFieldDef => ({
        key,
        label: key,
        type: "text",
        required: false,
        kind: (before[key] ?? "").length > 160 || (after[key] ?? "").length > 160 ? "body" : "control",
      }),
    );
  return [...schema.fields.filter((field) => field.key !== "body"), ...extra];
}

/**
 * Policy, procedure, and table items store facts in details and also copy them
 * into body. Compare the facts so a one-line edit is not hidden inside that copy.
 * Returns undefined when the stored details are not that shape.
 */
function structuredChanges(
  schema: LibrarySchema,
  beforeRaw: string | null,
  afterRaw: string | null,
): ReviewField[] | undefined {
  if (schema.starter === "general") return undefined;
  const before = detailValues(schema, beforeRaw);
  const after = detailValues(schema, afterRaw);
  if (!before || !after) return undefined;
  const fields: ReviewField[] = [];
  for (const field of fieldDefs(schema, before, after)) {
    pushChange(fields, field.label, before[field.key] ?? "", after[field.key] ?? "", field.kind === "body");
  }
  return fields;
}

function descriptionLabel(schema: LibrarySchema): string {
  return schema.fields.find((field) => field.key === "body")?.label ?? "Description";
}

/** Compare one Pending item with the last published copy. No snapshot means it is new. */
export function itemReview(
  current: ReviewSource,
  snapshot: ReviewSource | null,
  schema: LibrarySchema,
): ItemReview {
  if (!snapshot) return { kind: "new" };
  const fields: ReviewField[] = [];
  pushChange(fields, "Name", snapshot.name, current.name, false);
  pushChange(fields, "Labels", labelsText(snapshot.labels), labelsText(current.labels), false);
  pushChange(fields, "Aliases", labelsText(snapshot.aliases ?? []), labelsText(current.aliases ?? []), false);
  pushChange(fields, "Summary", snapshot.summary, current.summary, false);

  const structured = structuredChanges(schema, snapshot.details, current.details);
  if (structured) {
    fields.push(...structured);
    // Body is generated from those fields. Show it only when it drifted on its own.
    if (structured.length === 0 && snapshot.body !== current.body) {
      pushChange(fields, descriptionLabel(schema), snapshot.body, current.body, true);
    }
  } else {
    if (snapshot.body !== current.body) {
      pushChange(fields, descriptionLabel(schema), snapshot.body, current.body, true);
    }
    if ((snapshot.details ?? "") !== (current.details ?? "")) {
      pushChange(fields, "Details", snapshot.details ?? "", current.details ?? "", true);
    }
  }

  if (fields.length === 0) return { kind: "unchanged" };
  return { kind: "changed", fields };
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function sliceWindow(
  text: string,
  diffStart: number,
  diffEnd: number,
): { text: string; trimmed: boolean } {
  const from = Math.max(0, diffStart - WINDOW_PAD);
  const to = Math.min(text.length, diffEnd + WINDOW_PAD);
  const lead = from > 0 ? "… " : "";
  const trail = to < text.length ? " …" : "";
  return { text: lead + text.slice(from, to) + trail, trimmed: from > 0 || to < text.length };
}

/**
 * Keep a short edit visible inside a long field.
 * A large rewrite is capped; a small interior edit keeps the surrounding words.
 */
export function focusChange(
  before: string,
  after: string,
): { before: string; after: string; trimmed: boolean } {
  if (before.length <= SHORT_TEXT && after.length <= SHORT_TEXT) {
    return { before, after, trimmed: false };
  }
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before[start] === after[start]) start += 1;
  let tail = 0;
  while (
    tail < shared - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const beforeEnd = before.length - tail;
  const afterEnd = after.length - tail;
  const changed = Math.max(beforeEnd - start, afterEnd - start);
  if (changed > LARGE_REWRITE) {
    return {
      before: cap(before, CAP),
      after: cap(after, CAP),
      trimmed: before.length > CAP || after.length > CAP,
    };
  }
  const beforeView = sliceWindow(before, start, beforeEnd);
  const afterView = sliceWindow(after, start, afterEnd);
  return {
    before: beforeView.text,
    after: afterView.text,
    trimmed: beforeView.trimmed || afterView.trimmed,
  };
}

/** One run of text in an inline before/after highlight. */
export type DiffSpan =
  | { op: "equal"; text: string }
  | { op: "delete"; text: string }
  | { op: "insert"; text: string };

/**
 * Each word keeps the spaces after it so a full rewrite is one mark,
 * not deleted words with a plain space left in the middle.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const words = text.match(/\S+\s*/g) ?? [];
  const lead = text.match(/^\s+/);
  return lead ? [lead[0], ...words] : words;
}

/**
 * Word-level LCS so the shared words stay plain and only the edit is marked.
 * Used on the Pending list and the What changed box.
 */
export function sideDiff(
  before: string,
  after: string,
): { before: DiffSpan[]; after: DiffSpan[] } {
  if (before === after) {
    return {
      before: before ? [{ op: "equal", text: before }] : [],
      after: after ? [{ op: "equal", text: after }] : [],
    };
  }
  const left = tokenize(before);
  const right = tokenize(after);
  const m = left.length;
  const n = right.length;
  // dp[i][j] = LCS length of left[i..] and right[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        left[i] === right[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }

  const beforeSpans: DiffSpan[] = [];
  const afterSpans: DiffSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && left[i] === right[j]) {
      pushSpan(beforeSpans, "equal", left[i]!);
      pushSpan(afterSpans, "equal", right[j]!);
      i += 1;
      j += 1;
    } else if (j < n && (i === m || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      pushSpan(afterSpans, "insert", right[j]!);
      j += 1;
    } else if (i < m) {
      pushSpan(beforeSpans, "delete", left[i]!);
      i += 1;
    }
  }
  return { before: beforeSpans, after: afterSpans };
}

function pushSpan(spans: DiffSpan[], op: DiffSpan["op"], text: string): void {
  const last = spans[spans.length - 1];
  if (last && last.op === op) {
    last.text += text;
    return;
  }
  spans.push({ op, text });
}
