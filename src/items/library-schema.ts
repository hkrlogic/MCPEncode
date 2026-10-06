/**
 * Library field schema: copied from a starter at create, or from a table a
 * publisher approved. Agents may propose a table; they never apply one.
 */
import { z } from "zod/v4";
import { itemInputSchema, type ItemInput } from "./schema.ts";
import { formatTableItem } from "./table-proposal.ts";
import {
  formatPolicy,
  formatProcedure,
  type LibraryTemplate,
  type PolicyDetails,
  type ProcedureDetails,
  isLibraryTemplate,
} from "./templates.ts";

export type SchemaFieldType = "text" | "date" | "version" | "longtext" | "markdown";

export type SchemaFieldDef = {
  key: string;
  label: string;
  type: SchemaFieldType;
  required: boolean;
  /** control = one-line facts; body = longer prose blocks in the formatted item. */
  kind: "control" | "body";
  max?: number;
};

/** Stored on libraries.schema (JSONB). Starter id kept for UI / MCP copy. */
export type LibrarySchema = {
  starter: LibraryTemplate;
  fields: SchemaFieldDef[];
  /** Set when a publisher approved a proposed table. */
  tableName?: string;
};

export type SavedItem = ItemInput & { summary?: string; details?: string | null };

/**
 * Tool/form payload. Keys beyond name/labels/summary come from the library schema,
 * including columns on a table a publisher approved.
 */
export type ItemWriteInput = {
  name?: string;
  body?: string;
  labels?: string[];
  summary?: string;
  owner?: string;
  approved_by?: string;
  version?: string;
  effective_date?: string;
  review_date?: string;
  purpose?: string;
  scope?: string;
  policy?: string;
  /** Earlier Policy items called the statement "rule". */
  rule?: string;
  responsibilities?: string;
  exceptions?: string;
  references?: string;
  related_policy?: string;
  when_to_use?: string;
  steps?: string;
  who?: string;
  [key: string]: string | string[] | undefined;
};

const META_KEYS = new Set(["name", "labels", "summary", "body", "rule"]);

function policyStarterFields(): SchemaFieldDef[] {
  return [
    { key: "owner", label: "Owner", type: "text", required: true, kind: "control", max: 200 },
    { key: "approved_by", label: "Approved by", type: "text", required: false, kind: "control", max: 200 },
    { key: "version", label: "Version", type: "version", required: true, kind: "control", max: 20 },
    { key: "effective_date", label: "Effective date", type: "date", required: true, kind: "control" },
    { key: "review_date", label: "Review date", type: "date", required: true, kind: "control" },
    { key: "purpose", label: "Purpose", type: "longtext", required: true, kind: "body", max: 8_000 },
    { key: "scope", label: "Scope", type: "longtext", required: true, kind: "body", max: 8_000 },
    { key: "policy", label: "Policy", type: "longtext", required: true, kind: "body", max: 20_000 },
    {
      key: "responsibilities",
      label: "Responsibilities",
      type: "longtext",
      required: false,
      kind: "body",
      max: 12_000,
    },
    { key: "exceptions", label: "Exceptions", type: "longtext", required: false, kind: "body", max: 8_000 },
    { key: "references", label: "References", type: "longtext", required: false, kind: "body", max: 8_000 },
  ];
}

function procedureStarterFields(): SchemaFieldDef[] {
  return [
    { key: "owner", label: "Owner", type: "text", required: true, kind: "control", max: 200 },
    {
      key: "related_policy",
      label: "Related policy",
      type: "text",
      required: true,
      kind: "control",
      max: 200,
    },
    { key: "when_to_use", label: "When to use it", type: "longtext", required: true, kind: "body", max: 8_000 },
    { key: "steps", label: "Steps", type: "longtext", required: true, kind: "body", max: 20_000 },
    { key: "who", label: "Who does each step", type: "longtext", required: true, kind: "body", max: 8_000 },
  ];
}

function generalStarterFields(): SchemaFieldDef[] {
  return [
    { key: "body", label: "Description", type: "markdown", required: false, kind: "body", max: 50_000 },
  ];
}

/** Canonical starter → schema document (copied onto the library at create). */
export function schemaForStarter(starter: LibraryTemplate): LibrarySchema {
  if (starter === "policy") return { starter: "policy", fields: policyStarterFields() };
  if (starter === "procedure") return { starter: "procedure", fields: procedureStarterFields() };
  // An approved table replaces this empty copy. Create-library cannot pick it.
  if (starter === "table") return { starter: "table", fields: [] };
  return { starter: "general", fields: generalStarterFields() };
}

export function parseLibrarySchema(raw: unknown): LibrarySchema | undefined {
  if (raw == null) return undefined;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!isLibraryTemplate(String(row.starter ?? ""))) return undefined;
  if (!Array.isArray(row.fields)) return undefined;
  const fields: SchemaFieldDef[] = [];
  for (const entry of row.fields) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const field = entry as Record<string, unknown>;
    if (typeof field.key !== "string" || !field.key.trim()) return undefined;
    if (typeof field.label !== "string" || !field.label.trim()) return undefined;
    const type = field.type;
    if (
      type !== "text" &&
      type !== "date" &&
      type !== "version" &&
      type !== "longtext" &&
      type !== "markdown"
    ) {
      return undefined;
    }
    const def: SchemaFieldDef = {
      key: field.key.trim(),
      label: field.label.trim(),
      type,
      required: field.required === true,
      kind: field.kind === "control" ? "control" : "body",
    };
    if (typeof field.max === "number" && Number.isFinite(field.max)) def.max = field.max;
    fields.push(def);
  }
  const tableName =
    typeof row.tableName === "string" && row.tableName.trim()
      ? row.tableName.trim().slice(0, 80)
      : undefined;
  return {
    starter: row.starter as LibraryTemplate,
    fields,
    ...(tableName ? { tableName } : {}),
  };
}

/** Resolve stored JSONB (or fall back to the starter copy for the template). */
export function librarySchemaOf(
  template: LibraryTemplate,
  raw: unknown,
): LibrarySchema {
  return parseLibrarySchema(raw) ?? schemaForStarter(template);
}

export function schemaFieldMessage(schema: LibrarySchema): string {
  const required = schema.fields.filter((field) => field.required).map((field) => field.key);
  const optional = schema.fields.filter((field) => !field.required).map((field) => field.key);
  const kind =
    schema.starter === "table" && schema.tableName
      ? `table "${schema.tableName}"`
      : `${schema.starter} schema`;
  const parts = [
    `This library uses the ${kind}.`,
    `Send name${schema.starter === "general" ? "" : ", summary"}`,
    required.length > 0 ? `, ${required.join(", ")}` : "",
    ".",
  ];
  if (optional.length > 0) {
    parts.push(` Optional: ${optional.join(", ")}.`);
  }
  parts.push(" Do not invent fields.");
  return parts.join("");
}

/** Short field list for MCP agent instructions on this library. */
export function schemaAgentBlurb(schema: LibrarySchema): string {
  if (schema.starter === "general") {
    return "This library is General. Items use name, optional labels, and a markdown body (summary is derived from the body).";
  }
  if (schema.starter === "table") {
    const labels = schema.fields.map((field) => field.label).join(", ");
    const name = schema.tableName ? ` "${schema.tableName}"` : "";
    return `This library is the table${name}. Fixed columns: ${labels || "(none)"}. Use those names when adding or editing. Do not invent columns.`;
  }
  const labels = schema.fields.map((field) => field.label).join(", ");
  return `This library uses the ${schema.starter} schema. Fixed fields: ${labels}. Use those names when adding or editing. Do not invent fields.`;
}

/**
 * MCP tool argument types for create_item / update_item on this library only.
 * Built from the stored schema so clients do not see other starters' fields.
 */
function mcpZodForField(field: SchemaFieldDef): z.ZodType {
  const max = field.max ?? (field.type === "markdown" ? 50_000 : field.type === "text" ? 200 : 8_000);
  let description = field.label;
  if (field.type === "date") description = `${field.label} (YYYY-MM-DD)`;
  if (field.type === "version") description = `${field.label} (for example 1.0)`;
  if (field.type === "markdown") description = `${field.label} (markdown)`;
  const base = z.string().trim().max(max).describe(description);
  if (field.required) return base.min(1, `${field.label} is required`);
  return base.optional();
}

/** Field shape for create_item (no id). */
export function mcpItemWriteShape(schema: LibrarySchema): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {
    name: z.string().trim().min(1).max(200).describe("Item name"),
    labels: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .optional()
      .describe("Labels (optional)"),
  };
  if (schema.starter !== "general") {
    shape.summary = z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe("Required one-line summary (list/search excerpt)");
  }
  for (const field of schema.fields) {
    shape[field.key] = mcpZodForField(field);
  }
  // Legacy Policy alias — optional, only when this library has a policy field.
  if (schema.fields.some((field) => field.key === "policy")) {
    shape.rule = z
      .string()
      .max(20_000)
      .optional()
      .describe("Deprecated alias for policy; prefer policy");
  }
  return shape;
}

export function mcpCreateItemInputSchema(schema: LibrarySchema) {
  return z.object(mcpItemWriteShape(schema));
}

export function mcpUpdateItemInputSchema(schema: LibrarySchema) {
  return z.object({
    id: z.string().uuid().describe("Item id from list_items"),
    ...mcpItemWriteShape(schema),
  });
}

/** Sorted argument keys advertised on create_item for this library. */
export function mcpItemWriteKeys(schema: LibrarySchema): string[] {
  return Object.keys(mcpItemWriteShape(schema)).sort();
}

export function mcpWriteToolDescription(
  schema: LibrarySchema,
  kind: "create" | "update",
  writeMode: "reviewed" | "direct" = "reviewed",
): string {
  const fieldList = schema.fields
    .map((field) => (field.required ? field.key : `${field.key} (optional)`))
    .join(", ");
  const head =
    writeMode === "direct"
      ? kind === "create"
        ? "Add a library item. This library is Direct — the item is live immediately for readers and agents."
        : "Replace one library item. This library is Direct — the saved version is live immediately."
      : kind === "create"
        ? "Add a library item as a draft (Pending). Not visible to readers or the kiosk until a human Publishes it in the publisher UI."
        : "Replace one library item. Saves as draft: if published, it becomes Pending until a human Publishes again in the publisher UI.";
  const summaryBit = schema.starter === "general" ? "" : ", summary";
  return `${head} This library uses the ${schema.starter} schema. Send name${summaryBit}${fieldList ? `, ${fieldList}` : ""}. Optional: labels. Do not invent fields. Use only when the human asked.`;
}

function isoDate(label: string) {
  return z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be YYYY-MM-DD`)
    .refine((value) => {
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    }, `${label} must be a real date`);
}

function zodForField(field: SchemaFieldDef): z.ZodType<string> {
  const max = field.max ?? (field.type === "markdown" ? 50_000 : 8_000);
  if (field.type === "date") {
    return field.required ? isoDate(field.label) : isoDate(field.label).or(z.literal(""));
  }
  if (field.type === "version") {
    const version = z
      .string()
      .trim()
      .min(1, `${field.label} is required`)
      .max(max, `${field.label} must be ${max} characters or fewer`)
      .regex(/^\d+(\.\d+){0,2}$/, `${field.label} must look like 1.0`);
    return field.required ? version : z.string().trim().max(max).default("");
  }
  if (field.required) {
    return z
      .string()
      .trim()
      .min(1, `${field.label} is required`)
      .max(max, `${field.label} is too long`);
  }
  return z.string().trim().max(max).default("");
}

function unexpectedFields(schema: LibrarySchema, input: ItemWriteInput): string | undefined {
  const allowed = new Set<string>([...META_KEYS, ...schema.fields.map((field) => field.key)]);
  // Policy may still accept legacy "rule" as an alias for "policy".
  if (schema.fields.some((field) => field.key === "policy")) allowed.add("rule");
  const extras: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (!allowed.has(key)) extras.push(key);
  }
  // Non-general schemas do not take a free-form body unless "body" is a schema field.
  if (
    schema.starter !== "general" &&
    !schema.fields.some((field) => field.key === "body") &&
    typeof input.body === "string" &&
    input.body.trim()
  ) {
    extras.push("body");
  }
  if (extras.length === 0) return undefined;
  return `Unknown field(s): ${[...new Set(extras)].join(", ")}. ${schemaFieldMessage(schema)}`;
}

function readField(input: ItemWriteInput, key: string): string {
  if (key === "policy") {
    const policy = input.policy?.trim() || input.rule?.trim() || "";
    return policy;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Validate a write against the library's stored schema and build the saved item.
 * Accepts a LibrarySchema or a starter id (tests / legacy call sites).
 */
export function itemForLibrarySchema(
  schemaOrStarter: LibrarySchema | LibraryTemplate,
  input: ItemWriteInput,
): { ok: true; item: SavedItem } | { ok: false; message: string } {
  const schema =
    typeof schemaOrStarter === "string" ? schemaForStarter(schemaOrStarter) : schemaOrStarter;

  const unexpected = unexpectedFields(schema, input);
  if (unexpected) return { ok: false, message: unexpected };

  if (schema.starter === "general") {
    const parsed = itemInputSchema.safeParse({
      name: input.name,
      body: input.body ?? "",
      labels: input.labels ?? [],
    });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid item" };
    }
    return { ok: true, item: { ...parsed.data, details: null } };
  }

  const shape: Record<string, z.ZodType> = {
    name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer"),
    summary: z
      .string()
      .trim()
      .min(1, "Summary is required")
      .max(160, "Summary must be 160 characters or fewer"),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  };
  for (const field of schema.fields) {
    shape[field.key] = zodForField(field);
  }

  const payload: Record<string, unknown> = {
    name: input.name,
    summary: input.summary ?? "",
    labels: input.labels ?? [],
  };
  for (const field of schema.fields) {
    payload[field.key] = readField(input, field.key);
  }

  let parsed = z.object(shape).safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "Invalid item";
    return { ok: false, message: `${schemaFieldMessage(schema)} ${detail}` };
  }

  if (schema.starter === "policy") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    if (data.review_date && data.effective_date && data.review_date < data.effective_date) {
      return {
        ok: false,
        message: `${schemaFieldMessage(schema)} Review date must be on or after the effective date`,
      };
    }
    const details = Object.fromEntries(
      schema.fields.map((field) => [field.key, data[field.key] ?? ""]),
    ) as PolicyDetails;
    return {
      ok: true,
      item: {
        name: data.name,
        body: formatPolicy(details),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify(details),
      },
    };
  }

  if (schema.starter === "procedure") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const details = Object.fromEntries(
      schema.fields.map((field) => [field.key, data[field.key] ?? ""]),
    ) as ProcedureDetails;
    return {
      ok: true,
      item: {
        name: data.name,
        body: formatProcedure(details),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify(details),
      },
    };
  }

  if (schema.starter === "table") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const values = Object.fromEntries(schema.fields.map((field) => [field.key, data[field.key] ?? ""]));
    return {
      ok: true,
      item: {
        name: data.name,
        body: formatTableItem(schema.tableName || "Table", schema.fields, values),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify({ _kind: "table", values }),
      },
    };
  }

  return { ok: false, message: schemaFieldMessage(schema) };
}
