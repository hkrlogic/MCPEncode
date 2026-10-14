/**
 * A table proposed over MCP. It is not the library schema until a publisher
 * approves it in the portal. Agents cannot approve or reject.
 */
import { FIELD_TYPE_MAX } from "./field-limits.ts";
import { z } from "zod/v4";
import type { LibrarySchema, SchemaFieldDef } from "./library-schema.ts";

export const TABLE_COLUMN_TYPES = ["text", "date", "longtext"] as const;
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

/** Caps keep a proposal reviewable on one screen and bound the stored JSON. */
export const MAX_TABLE_COLUMNS = 12;
export const MAX_SAMPLE_ROWS = 5;
const MAX_TABLE_NAME = 80;
const MAX_COLUMN_LABEL = 40;
const MAX_SAMPLE_CELL = 500;

const RESERVED_KEYS = new Set([
  "name",
  "labels",
  "summary",
  "body",
  "id",
  "status",
  "rule",
  "library_id",
]);

export type TableProposalColumn = {
  key: string;
  label: string;
  type: TableColumnType;
  required: boolean;
};

/** Stored on libraries.table_proposal. Sample rows are for review only. */
export type TableProposal = {
  name: string;
  columns: TableProposalColumn[];
  sampleRows: Record<string, string>[];
  proposedBy: string;
  proposedAt: number;
};

export const proposeTableInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Table name is required")
    .max(MAX_TABLE_NAME, `Table name must be ${MAX_TABLE_NAME} characters or fewer`)
    .describe("Name of the table a publisher will approve"),
  columns: z
    .array(
      z.object({
        label: z
          .string()
          .trim()
          .min(1, "Each column needs a label")
          .max(MAX_COLUMN_LABEL, `Column labels must be ${MAX_COLUMN_LABEL} characters or fewer`),
        type: z.enum(TABLE_COLUMN_TYPES).describe("text, date (YYYY-MM-DD), or longtext"),
        required: z
          .boolean()
          .optional()
          .describe("Whether each item must fill this column. Defaults to true"),
      }),
    )
    .min(1, "A table needs at least one column")
    .max(MAX_TABLE_COLUMNS, `A table can have at most ${MAX_TABLE_COLUMNS} columns`),
  sample_rows: z
    .array(z.unknown())
    .max(MAX_SAMPLE_ROWS, `Send at most ${MAX_SAMPLE_ROWS} sample rows`)
    .optional()
    .describe(
      "Optional example rows keyed by column label, so a publisher can see the intent. Not saved as items.",
    ),
});

export type ProposeTableInput = z.infer<typeof proposeTableInputSchema>;

/** Columns and sample rows after checks, before the server stamps who proposed it. */
export type TableProposalDraft = Omit<TableProposal, "proposedBy" | "proposedAt">;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function columnKey(label: string): string {
  const ascii = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let base = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = base ? `col_${base}` : "column";
  return base.slice(0, 32);
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base.slice(0, 40);
  let n = 2;
  while (used.has(key)) {
    const suffix = `_${n}`;
    key = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(key);
  return key;
}

function cleanLabel(label: string): string | undefined {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_COLUMN_LABEL) return undefined;
  if (/[\u0000-\u001f<>]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Turn a tool payload into columns and sample rows.
 * proposedBy is set by the server from the signed-in subject, never from this payload.
 */
export function normalizeTableProposal(
  input: ProposeTableInput,
): { ok: true; draft: TableProposalDraft } | { ok: false; message: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_TABLE_NAME || /[\u0000-\u001f<>]/.test(name)) {
    return { ok: false, message: "Table name is required and cannot include raw control characters." };
  }

  const used = new Set<string>();
  const seenLabels = new Set<string>();
  const columns: TableProposalColumn[] = [];
  for (const column of input.columns) {
    const label = cleanLabel(column.label);
    if (!label) {
      return { ok: false, message: "Each column needs a short label without raw control characters." };
    }
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return { ok: false, message: `Column "${label}" is listed twice. Use each label once.` };
    }
    seenLabels.add(labelKey);
    const base = columnKey(label);
    if (RESERVED_KEYS.has(base)) {
      return {
        ok: false,
        message: `Column "${label}" clashes with the item name, labels, or summary. Pick another column name.`,
      };
    }
    if (column.type !== "text" && column.type !== "date" && column.type !== "longtext") {
      return { ok: false, message: `Column "${label}" must be text, date, or longtext.` };
    }
    columns.push({
      key: uniqueKey(base, used),
      label,
      type: column.type,
      required: column.required !== false,
    });
  }

  const byLabel = new Map(columns.map((column) => [column.label.toLowerCase(), column]));
  const sampleRows: Record<string, string>[] = [];
  for (const [index, row] of (input.sample_rows ?? []).entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, message: `Sample row ${index + 1} must be an object keyed by column label.` };
    }
    const cells: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(row)) {
      if (typeof rawValue !== "string") {
        return { ok: false, message: `Sample row ${index + 1} column "${rawKey}" must be text.` };
      }
      const column = byLabel.get(rawKey.trim().toLowerCase());
      if (!column) {
        return {
          ok: false,
          message: `Sample row ${index + 1} has unknown column "${rawKey}". Use the column labels.`,
        };
      }
      const value = rawValue.trim();
      if (value.length > MAX_SAMPLE_CELL) {
        return {
          ok: false,
          message: `Sample row ${index + 1} column "${column.label}" is too long.`,
        };
      }
      if (column.type === "date" && value && !isRealDate(value)) {
        return {
          ok: false,
          message: `Sample row ${index + 1} column "${column.label}" must be YYYY-MM-DD.`,
        };
      }
      cells[column.key] = value;
    }
    sampleRows.push(cells);
  }

  return { ok: true, draft: { name, columns, sampleRows } };
}

export function schemaFromProposal(proposal: TableProposal): LibrarySchema {
  const fields: SchemaFieldDef[] = proposal.columns.map((column) => {
    const field: SchemaFieldDef = {
      key: column.key,
      label: column.label,
      type: column.type,
      required: column.required,
      kind: column.type === "longtext" ? "body" : "control",
    };
    if (column.type === "text") field.max = FIELD_TYPE_MAX.text;
    if (column.type === "longtext") field.max = FIELD_TYPE_MAX.longtext;
    return field;
  });
  return { starter: "table", tableName: proposal.name, fields };
}

const STORED_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Read libraries.table_proposal. Unreadable JSON stays rejectable and cannot be approved. */
export function parseStoredTableProposal(
  raw: unknown,
): { proposal: TableProposal | null; unreadable: boolean } {
  if (raw == null) return { proposal: null, unreadable: false };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { proposal: null, unreadable: true };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { proposal: null, unreadable: true };
  }
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name || name.length > MAX_TABLE_NAME || !Array.isArray(row.columns) || row.columns.length === 0) {
    return { proposal: null, unreadable: true };
  }
  if (row.columns.length > MAX_TABLE_COLUMNS) return { proposal: null, unreadable: true };

  const columns: TableProposalColumn[] = [];
  const keys = new Set<string>();
  for (const entry of row.columns) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { proposal: null, unreadable: true };
    const column = entry as Record<string, unknown>;
    const key = typeof column.key === "string" ? column.key : "";
    const label = typeof column.label === "string" ? column.label.trim() : "";
    const type = column.type;
    if (!STORED_KEY.test(key) || RESERVED_KEYS.has(key) || keys.has(key)) {
      return { proposal: null, unreadable: true };
    }
    if (!label || label.length > MAX_COLUMN_LABEL) return { proposal: null, unreadable: true };
    if (type !== "text" && type !== "date" && type !== "longtext") return { proposal: null, unreadable: true };
    keys.add(key);
    columns.push({ key, label, type, required: column.required !== false });
  }

  const sampleRows: Record<string, string>[] = [];
  if (row.sampleRows != null) {
    if (!Array.isArray(row.sampleRows) || row.sampleRows.length > MAX_SAMPLE_ROWS) {
      return { proposal: null, unreadable: true };
    }
    for (const sample of row.sampleRows) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
        return { proposal: null, unreadable: true };
      }
      const cells: Record<string, string> = {};
      for (const [key, cell] of Object.entries(sample as Record<string, unknown>)) {
        if (!keys.has(key) || typeof cell !== "string" || cell.length > MAX_SAMPLE_CELL) {
          return { proposal: null, unreadable: true };
        }
        cells[key] = cell;
      }
      sampleRows.push(cells);
    }
  }

  return {
    proposal: {
      name,
      columns,
      sampleRows,
      proposedBy: typeof row.proposedBy === "string" ? row.proposedBy.slice(0, 255) : "",
      proposedAt: typeof row.proposedAt === "number" && Number.isFinite(row.proposedAt) ? row.proposedAt : 0,
    },
    unreadable: false,
  };
}

export function formatTableItem(
  tableName: string,
  fields: SchemaFieldDef[],
  values: Record<string, string>,
): string {
  const control = fields
    .filter((field) => field.kind === "control")
    .map((field) => `${field.label}: ${values[field.key] ?? ""}`);
  const body = fields
    .filter((field) => field.kind === "body")
    .map((field) => {
      const value = (values[field.key] ?? "").trim();
      return value ? `${field.label}:\n${value}` : `${field.label}:`;
    });
  return [`Table: ${tableName}`, ...control, "", ...body].join("\n").trim();
}

export function parseTableValues(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (row._kind !== "table" || !row.values || typeof row.values !== "object" || Array.isArray(row.values)) {
      return undefined;
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.values as Record<string, unknown>)) {
      if (typeof value === "string") values[key] = value;
    }
    return values;
  } catch {
    return undefined;
  }
}

/**
 * Field values for edit forms: table rows, extended General, or flat Policy/Procedure JSON.
 */
export function parseItemFieldValues(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const table = parseTableValues(raw);
  if (table) return table;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (row._kind === "fields" && row.values && typeof row.values === "object" && !Array.isArray(row.values)) {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.values as Record<string, unknown>)) {
        if (typeof value === "string") values[key] = value;
      }
      return values;
    }
    // Flat Policy / Procedure details (no _kind).
    if (row._kind != null) return undefined;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string") values[key] = value;
    }
    return Object.keys(values).length > 0 ? values : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Values for the schema edit form. When a Documents library gains add-on fields,
 * older items still have markdown in body and null details — seed body so edit
 * does not blank the description.
 */
export function valuesForSchemaEdit(
  item: { body: string; details: string | null },
  schema: { starter: string; fields: { key: string }[] },
): Record<string, string> {
  const parsed = parseItemFieldValues(item.details);
  if (parsed) return parsed;
  if (
    schema.starter === "general" &&
    schema.fields.some((field) => field.key !== "body") &&
    schema.fields.some((field) => field.key === "body")
  ) {
    return { body: item.body };
  }
  return {};
}

export function tableControl(
  fields: SchemaFieldDef[],
  values: Record<string, string>,
): { label: string; value: string }[] {
  return fields
    .filter((field) => field.kind === "control" && (values[field.key] ?? "").trim())
    .map((field) => ({ label: field.label, value: values[field.key] ?? "" }));
}

export function tableParts(
  fields: SchemaFieldDef[],
  values: Record<string, string>,
): { label: string; text: string }[] {
  return fields
    .filter((field) => field.kind === "body" && (values[field.key] ?? "").trim())
    .map((field) => ({ label: field.label, text: (values[field.key] ?? "").trim() }));
}
