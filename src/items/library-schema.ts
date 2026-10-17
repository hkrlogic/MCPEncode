/**
 * Library field schema: copied from a starter at create, or from a table a
 * publisher approved. Agents may propose a table; they never apply one.
 */
import { z } from "zod/v4";
import {
  entityKeySchema,
  itemInputSchema,
  excerptOf,
  normalizeEntityKey,
  normalizeLabels,
  type ItemInput,
} from "./schema.ts";
import { formatTableItem } from "./table-proposal.ts";
import { FIELD_TYPE_MAX, fieldMax } from "./field-limits.ts";
import { type LibraryTemplate, isLibraryTemplate } from "./templates.ts";

export { FIELD_TYPE_MAX, fieldMax };

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

const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;

/** Stored on libraries.schema (JSONB). Starter id kept for UI / MCP copy. */
export type LibrarySchema = {
  starter: LibraryTemplate;
  fields: SchemaFieldDef[];
  /** Set when a publisher approved a proposed table. */
  tableName?: string;
  /**
   * Built on Add library → Custom. Name, labels, and summary stay.
   * `fields` is the rest, locked at create (may be empty).
   */
  custom?: boolean;
};

export type SavedItem = ItemInput & {
  summary?: string;
  details?: string | null;
  entity_key?: string | null;
};

/**
 * Tool/form payload. Keys beyond name/labels/summary come from the library schema,
 * including columns on a table a publisher approved.
 */
export type ItemWriteInput = {
  name?: string;
  body?: string;
  labels?: string[];
  summary?: string;
  entity_key?: string;
  owner?: string;
  approved_by?: string;
  version?: string;
  effective_date?: string;
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

const META_KEYS = new Set(["name", "labels", "summary", "body", "rule", "entity_key"]);

function attachEntityKey(
  item: SavedItem,
  input: ItemWriteInput,
): { ok: true; item: SavedItem } | { ok: false; message: string } {
  // Omit means "leave unset" on create / "keep existing" on update.
  if (input.entity_key === undefined) return { ok: true, item };
  const parsed = entityKeySchema.safeParse(input.entity_key);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid entity key" };
  }
  return { ok: true, item: { ...item, entity_key: normalizeEntityKey(parsed.data) ?? undefined } };
}

function policyStarterFields(): SchemaFieldDef[] {
  return [
    { key: "owner", label: "Owner", type: "text", required: true, kind: "control", max: 200 },
    { key: "approved_by", label: "Approved by", type: "text", required: false, kind: "control", max: 200 },
    { key: "version", label: "Version", type: "version", required: true, kind: "control", max: 20 },
    { key: "effective_date", label: "Effective date", type: "date", required: true, kind: "control" },
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
  const custom = row.starter === "general" && row.custom === true;
  return {
    starter: row.starter as LibraryTemplate,
    fields,
    ...(tableName ? { tableName } : {}),
    ...(custom ? { custom: true } : {}),
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
  const kind = schema.custom
    ? "custom schema"
    : schema.starter === "table" && schema.tableName
      ? `table "${schema.tableName}"`
      : `${schema.starter} schema`;
  const needsSummary = !summaryIsDerived(schema);
  const parts = [
    `This library uses the ${kind}. `,
    `Send name${needsSummary ? ", summary" : ""}`,
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
/** True when Documents/General has approved add-on fields beyond the markdown body. */
export function generalHasExtraFields(schema: LibrarySchema): boolean {
  return schema.starter === "general" && schema.fields.some((field) => field.key !== "body");
}

/**
 * General with only the markdown description.
 * A custom schema is not this, even when it has no extra fields.
 */
export function isPlainGeneral(schema: LibrarySchema): boolean {
  return schema.starter === "general" && schema.custom !== true && !generalHasExtraFields(schema);
}

/**
 * General (not custom) derives its summary from the body, before and after an
 * approved add-on field. Approving an optional field must not make summary
 * required, or every existing agent write without one would start failing.
 */
export function summaryIsDerived(schema: LibrarySchema): boolean {
  return schema.starter === "general" && schema.custom !== true;
}

/**
 * Format control + body fields for Policy / Procedure / extended General.
 * Uses the library schema so approved add-on fields appear in the item body.
 */
export function formatSchemaFields(
  title: string,
  fields: SchemaFieldDef[],
  values: Record<string, string>,
): string {
  // Empty optional fields are left out, so the body has no bare "Purchased:" lines.
  const control = fields
    .filter((field) => field.kind === "control" && (values[field.key] ?? "").trim())
    .map((field) => `${field.label}: ${(values[field.key] ?? "").trim()}`);
  const body = fields
    .filter((field) => field.kind === "body" && (values[field.key] ?? "").trim())
    .map((field) => `${field.label}:\n${(values[field.key] ?? "").trim()}`);
  return [title, ...control, "", ...body].join("\n").trim();
}

export function schemaAgentBlurb(schema: LibrarySchema): string {
  if (schema.custom) {
    const labels = schema.fields.map((field) => field.label).join(", ");
    const extra = labels ? ` Other fields: ${labels}.` : " No other fields.";
    return `This library uses a custom schema. Every item has a name, labels, and a summary.${extra} Use those names when adding or editing. Do not invent fields. To add a field after lock, propose_field (one optional field); a human Approves it in the publisher.`;
  }
  if (schema.starter === "general" && !generalHasExtraFields(schema)) {
    return "This library is General. Items use name, optional labels, and a markdown body (summary is derived from the body). To add a field, propose_field after the human confirms; they Approve in the publisher.";
  }
  if (schema.starter === "table") {
    const labels = schema.fields.map((field) => field.label).join(", ");
    const name = schema.tableName ? ` "${schema.tableName}"` : "";
    return `This library is the table${name}. Columns: ${labels || "(none)"}. Use those names when adding or editing. Do not invent columns. To add a column after lock, propose_field (one optional field); a human Approves it.`;
  }
  const labels = schema.fields.map((field) => field.label).join(", ");
  return `This library uses the ${schema.starter} schema. Fields: ${labels}. Use those names when adding or editing. Do not invent fields. To add a field after lock, propose_field (one optional field); a human Approves it in the publisher.`;
}

/**
 * MCP tool argument types for create_item / update_item on this library only.
 * Built from the stored schema so clients do not see other starters' fields.
 */
/**
 * Tool arguments are advertised with their JSON type but not enforced by the SDK:
 * the save check enforces types, required fields and limits, and reports every
 * problem in one answer (the SDK would stop at its own first pass).
 */
function advertisedString(description: string): z.ZodType {
  return z.unknown().optional().meta({ type: "string", description });
}

function mcpZodForField(field: SchemaFieldDef): z.ZodType {
  const max = fieldMax(field);
  let description = field.label;
  if (field.type === "date") description = `${field.label} (YYYY-MM-DD)`;
  if (field.type === "version") description = `${field.label} (for example 1.0)`;
  if (field.type === "markdown") description = `${field.label} (markdown)`;
  const rule = field.required ? `Required. At most ${max} characters.` : `Optional. At most ${max} characters.`;
  return advertisedString(`${description}. ${rule}`);
}

/** Field shape for create_item (no id). */
export function mcpItemWriteShape(schema: LibrarySchema): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {
    // Advertised, not enforced (see advertisedString): the save check reports every problem at once.
    name: advertisedString("Item name. Required. At most 200 characters."),
    entity_key: advertisedString(
      "Optional stable id for this real-world entity (for example host:contoso-01). Letters, digits and . _ : / - ; at most 120 characters.",
    ),
    labels: z.unknown().optional().meta({
      type: "array",
      items: { type: "string" },
      description: "Optional labels: at most 20, each at most 40 characters. Stored lower case.",
    }),
  };
  if (summaryIsDerived(schema)) {
    if (!isPlainGeneral(schema)) {
      shape.summary = advertisedString(
        "Optional one-line summary (list/search excerpt), at most 160 characters. Derived from the body when omitted",
      );
    }
  } else {
    shape.summary = advertisedString("One-line summary (list/search excerpt). Required. At most 160 characters.");
  }
  for (const field of schema.fields) {
    shape[field.key] = mcpZodForField(field);
  }
  // Legacy Policy alias — optional, only when this library has a policy field.
  if (schema.fields.some((field) => field.key === "policy")) {
    shape.rule = advertisedString("Deprecated alias for policy; prefer policy");
  }
  return shape;
}

/**
 * Loose objects: keys that are not fields of this library reach the handler,
 * which refuses them with the field list (instead of dropping them silently).
 */
export function mcpCreateItemInputSchema(schema: LibrarySchema) {
  return z.object(mcpItemWriteShape(schema)).loose();
}

/** Every field optional: omitted fields keep their stored value unless replace is true. */
export function mcpUpdateItemInputSchema(schema: LibrarySchema) {
  const partial = Object.fromEntries(
    Object.entries(mcpItemWriteShape(schema)).map(([key, value]) => [key, value.optional()]),
  );
  return z.object({
    id: z.string().uuid().describe("Item id from list_items"),
    ...partial,
    replace: z
      .boolean()
      .optional()
      .describe(
        "Optional. Default false: fields you leave out keep their current value. true: replace the whole item, so omitted optional fields are cleared.",
      ),
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Optional. The revision from open_item / update_item that this edit is based on. If the item changed since, nothing is saved and a conflict is returned. Omit to overwrite (old behavior).",
      ),
  }).loose();
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
        ? "Add an item; Review Unlock, so it is live immediately. Set entity_key for the real-world entity: if an item with that entity_key already exists, it is updated instead. Give a stable name, a one-line summary, and useful labels."
        : "Update one item by id (find it with list_items, prefer entity_key). Fields you leave out keep their current value; replace: true replaces the whole item. Review Unlock: live immediately."
      : kind === "create"
        ? "Add an item as a Pending draft; readers see it only after a human Publishes. If an item with the optional entity_key already exists, it is updated instead."
        : "Update one item by id. Fields you leave out keep their current value; replace: true replaces the whole item. Saves as Pending; readers keep the published version until a human Publishes.";
  const summaryBit = summaryIsDerived(schema) ? "" : ", summary";
  const shape = schema.custom ? "custom" : schema.starter;
  return `${head} ${shape} schema: send name${summaryBit}${fieldList ? `, ${fieldList}` : ""}; optional entity_key, labels. Do not invent fields. Every problem comes back in one answer.`;
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
  const max = fieldMax(field);
  if (field.type === "date") {
    return field.required ? isoDate(field.label) : isoDate(field.label).or(z.literal(""));
  }
  if (field.type === "version") {
    const version = z
      .string()
      .trim()
      .min(1, `${field.label} is required`)
      .max(max, `${field.label} must be ${max} characters or fewer`)
      .regex(VERSION_PATTERN, `${field.label} must look like 1.0`);
    if (field.required) return version;
    // Optional, but a value that is given must still look like a version.
    return z
      .string()
      .trim()
      .max(max, `${field.label} must be ${max} characters or fewer`)
      .refine((value) => value === "" || VERSION_PATTERN.test(value), `${field.label} must look like 1.0`)
      .default("");
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

function unexpectedFields(schema: LibrarySchema, input: ItemWriteInput): string[] {
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
    !isPlainGeneral(schema) &&
    !schema.fields.some((field) => field.key === "body") &&
    typeof input.body === "string" &&
    input.body.trim()
  ) {
    extras.push("body");
  }
  const issues: string[] = [];
  if (input.labels !== undefined && !Array.isArray(input.labels)) {
    issues.push("labels must be an array of strings, for example [\"vpn\", \"security\"].");
  }
  if (extras.length > 0) issues.push(`Unknown field(s): ${[...new Set(extras)].join(", ")}.`);
  return issues;
}

/**
 * Agent writes only: plain General derives the summary from the body, so a summary
 * sent over MCP used to be dropped silently. Refuse it instead. (Internal callers
 * may still pass one; it is ignored there as before.)
 */
export function plainGeneralSummaryIssue(schema: LibrarySchema, input: ItemWriteInput): string | undefined {
  if (!isPlainGeneral(schema)) return undefined;
  if (typeof input.summary !== "string" || !input.summary.trim()) return undefined;
  return `summary is not a field in this library: it is derived from the body. Put the text in body instead. ${schemaFieldMessage(schema)}`;
}

/** One readable line per zod issue; generic zod wording gets the field key in front. */
function issueLines(issues: readonly { message: string; path: readonly PropertyKey[] }[]): string[] {
  return issues.map((issue) => {
    const key = issue.path.map(String).join(".");
    const message = issue.message.trim();
    const generic = /^(Invalid|Too (small|big)|Expected)/.test(message);
    const line = generic && key ? `${key}: ${message}` : message;
    return /[.!?]$/.test(line) ? line : `${line}.`;
  });
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

  // Every problem is collected and returned together, not just the first.
  const issues = unexpectedFields(schema, input);
  if (input.entity_key !== undefined) {
    const key = entityKeySchema.safeParse(input.entity_key);
    if (!key.success) issues.push(issueLines(key.error.issues).join(" "));
  }
  const failed = (more: string[]) => ({
    ok: false as const,
    message: `${[...issues, ...more].join(" ")} ${schemaFieldMessage(schema)}`.trim(),
  });

  // Plain Documents: markdown body only (no approved add-on fields yet).
  if (isPlainGeneral(schema)) {
    const parsed = itemInputSchema.safeParse({
      name: input.name,
      body: input.body ?? "",
      labels: normalizeLabels(input.labels),
    });
    if (!parsed.success) return failed(issueLines(parsed.error.issues));
    if (issues.length > 0) return failed([]);
    return attachEntityKey({ ...parsed.data, details: null }, input);
  }

  const shape: Record<string, z.ZodType> = {
    name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer"),
    summary: summaryIsDerived(schema)
      ? z.string().trim().max(160, "Summary must be 160 characters or fewer")
      : z
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
    labels: normalizeLabels(input.labels),
  };
  for (const field of schema.fields) {
    payload[field.key] = readField(input, field.key);
  }

  const parsed = z.object(shape).safeParse(payload);
  if (!parsed.success) {
    return failed(issueLines(parsed.error.issues));
  }
  if (issues.length > 0) return failed([]);

  if (schema.starter === "policy") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const details = Object.fromEntries(
      schema.fields.map((field) => [field.key, data[field.key] ?? ""]),
    );
    return attachEntityKey(
      {
        name: data.name,
        body: formatSchemaFields("Template: Policy", schema.fields, details),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify(details),
      },
      input,
    );
  }

  if (schema.starter === "procedure") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const details = Object.fromEntries(
      schema.fields.map((field) => [field.key, data[field.key] ?? ""]),
    );
    return attachEntityKey(
      {
        name: data.name,
        body: formatSchemaFields("Template: Procedure", schema.fields, details),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify(details),
      },
      input,
    );
  }

  if (schema.starter === "table") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const values = Object.fromEntries(schema.fields.map((field) => [field.key, data[field.key] ?? ""]));
    return attachEntityKey(
      {
        name: data.name,
        body: formatTableItem(schema.tableName || "Table", schema.fields, values),
        labels: data.labels,
        summary: data.summary,
        details: JSON.stringify({ _kind: "table", values }),
      },
      input,
    );
  }

  // Custom schema, or General after an approved add-on field.
  if (schema.starter === "general") {
    const data = parsed.data as Record<string, string> & { name: string; summary: string; labels: string[] };
    const values = Object.fromEntries(schema.fields.map((field) => [field.key, data[field.key] ?? ""]));
    const title = schema.custom ? "Template: Custom" : "Template: General";
    return attachEntityKey(
      {
        name: data.name,
        body: formatSchemaFields(title, schema.fields, values),
        labels: data.labels,
        summary: data.summary || (schema.custom ? "" : excerptOf(values.body ?? "")),
        details: JSON.stringify({ _kind: "fields", values }),
      },
      input,
    );
  }

  return failed([]);
}

/**
 * Web form wording for a save error. Agent messages lead with the field list
 * ("This library uses the … schema. Send name, …. Do not invent fields.") and
 * tool names; people filling in a form need only what to fix.
 */
export function humanItemMessage(message: string, schema: LibrarySchema): string {
  if (/entity_key already exists|duplicate key value/i.test(message)) {
    return "Another item in this library already uses this entity key. Edit that item instead, or use a different key.";
  }
  const prefix = schemaFieldMessage(schema);
  let text = message.split(prefix).join(" ").replace(/\s+/g, " ").trim();
  text = text.replace(/Unknown field\(s\): ([^.]+)\./, (_m, keys: string) => `This library has no field called ${keys}.`);
  text = text.replace(/\s*Do not invent fields\.?/g, "").trim();
  const label = (key: string) =>
    schema.fields.find((field) => field.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
  text = text
    .replace(/(\w+): Too small: expected string to have >=1 characters?\.?/g, (_m, key: string) => `${label(key)} can't be empty.`)
    .replace(/(\w+): Too big: expected string to have <=(\d+) characters?\.?/g, (_m, key: string, n: string) => `${label(key)} is too long (at most ${n} characters).`)
    .replace(/(\w+): Invalid input: expected \w+, received undefined\.?/g, (_m, key: string) => `${label(key)} is required.`)
    .replace(/(\w+): Invalid input[^.]*\.?/g, (_m, key: string) => `${label(key)} has a value this library can't use.`);
  if (!text) return "Check the highlighted fields and try again.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
