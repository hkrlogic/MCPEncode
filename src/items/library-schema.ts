/**
 * Per-library schema: field definitions (JSON) and validation of typed values.
 * Not SQL DDL. Agents and the UI edit this contract; MariaDB stores values in typed rows.
 */
import { z } from "zod/v4";

export const FIELD_TYPES = ["string", "number", "date", "enum", "boolean"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type SchemaField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  max?: number;
  values?: string[];
};

export type LibrarySchemaDoc = {
  fields: SchemaField[];
};

const fieldKeySchema = z
  .string()
  .trim()
  .min(1, "Field key is required")
  .max(64, "Field key must be 64 characters or fewer")
  .regex(/^[a-z][a-z0-9_]*$/, "Field key must be lowercase letters, numbers, underscores");

export const schemaFieldSchema = z
  .object({
    key: fieldKeySchema,
    label: z.string().trim().min(1, "Label is required").max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    max: z.number().int().min(1).max(2000).optional(),
    values: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "enum" && (!field.values || field.values.length === 0)) {
      ctx.addIssue({ code: "custom", message: "Enum fields need at least one value", path: ["values"] });
    }
    if (field.type !== "enum" && field.values && field.values.length > 0) {
      ctx.addIssue({ code: "custom", message: "Only enum fields may list values", path: ["values"] });
    }
  });

export const librarySchemaDocSchema = z
  .object({
    fields: z.array(schemaFieldSchema).max(40),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const [index, field] of doc.fields.entries()) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate field key: ${field.key}`,
          path: ["fields", index, "key"],
        });
      }
      seen.add(field.key);
    }
  });

export type FieldValueMap = Record<string, string | number | boolean | null | undefined>;

export type TypedFieldValue = {
  field_key: string;
  value_string: string | null;
  value_number: number | null;
  value_date: string | null;
  value_boolean: boolean | null;
};

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Date must be a real date");

/** Parse schema JSON from the database. */
export function parseLibrarySchemaDoc(raw: string): LibrarySchemaDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Library schema is not valid JSON");
  }
  const result = librarySchemaDocSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid library schema");
  }
  return result.data;
}

export function stringifyLibrarySchemaDoc(doc: LibrarySchemaDoc): string {
  return JSON.stringify({ fields: doc.fields });
}

/**
 * Validate a map of field values against a published schema.
 * Returns typed rows ready for item_field_values, or an error message.
 */
export function validateFieldValues(
  schema: LibrarySchemaDoc,
  input: FieldValueMap,
): { ok: true; rows: TypedFieldValue[] } | { ok: false; message: string } {
  const rows: TypedFieldValue[] = [];
  const unknown = Object.keys(input).filter(
    (key) => key && !schema.fields.some((field) => field.key === key),
  );
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field(s): ${unknown.join(", ")}` };
  }

  for (const field of schema.fields) {
    const raw = input[field.key];
    const empty =
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && raw.trim() === "");

    if (empty) {
      if (field.required) {
        return { ok: false, message: `${field.label} is required` };
      }
      continue;
    }

    const base = {
      field_key: field.key,
      value_string: null as string | null,
      value_number: null as number | null,
      value_date: null as string | null,
      value_boolean: null as boolean | null,
    };

    if (field.type === "string") {
      const text = String(raw).trim();
      const max = field.max ?? 2000;
      if (text.length > max) {
        return { ok: false, message: `${field.label} must be ${max} characters or fewer` };
      }
      rows.push({ ...base, value_string: text });
      continue;
    }

    if (field.type === "number") {
      const num = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) {
        return { ok: false, message: `${field.label} must be a number` };
      }
      rows.push({ ...base, value_number: num });
      continue;
    }

    if (field.type === "date") {
      const text = String(raw).trim();
      const parsed = isoDate.safeParse(text);
      if (!parsed.success) {
        return { ok: false, message: `${field.label} must be YYYY-MM-DD` };
      }
      rows.push({ ...base, value_date: parsed.data });
      continue;
    }

    if (field.type === "boolean") {
      let flag: boolean;
      if (typeof raw === "boolean") flag = raw;
      else {
        const text = String(raw).trim().toLowerCase();
        if (text === "true" || text === "1" || text === "yes") flag = true;
        else if (text === "false" || text === "0" || text === "no") flag = false;
        else return { ok: false, message: `${field.label} must be true or false` };
      }
      rows.push({ ...base, value_boolean: flag });
      continue;
    }

    if (field.type === "enum") {
      const text = String(raw).trim();
      if (!field.values?.includes(text)) {
        return {
          ok: false,
          message: `${field.label} must be one of: ${(field.values ?? []).join(", ")}`,
        };
      }
      rows.push({ ...base, value_string: text });
    }
  }

  return { ok: true, rows };
}

/** Turn typed rows into a plain map for forms and MCP. */
export function fieldValuesToMap(rows: TypedFieldValue[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    if (row.value_string !== null) out[row.field_key] = row.value_string;
    else if (row.value_number !== null) out[row.field_key] = row.value_number;
    else if (row.value_date !== null) out[row.field_key] = row.value_date;
    else if (row.value_boolean !== null) out[row.field_key] = row.value_boolean;
  }
  return out;
}

/** Labeled lines for agent wire format. */
export function labeledFieldValues(
  schema: LibrarySchemaDoc,
  rows: TypedFieldValue[],
): string {
  const map = fieldValuesToMap(rows);
  if (schema.fields.length === 0) return "";
  const lines = ["fields:"];
  for (const field of schema.fields) {
    const value = map[field.key];
    lines.push(
      value === undefined ? `${field.label}: (empty)` : `${field.label}: ${String(value)}`,
    );
  }
  return lines.join("\n");
}

/** Parse schema fields from a UI form (fields_json textarea or repeated rows). */
export function schemaDocFromFormJson(raw: string): { ok: true; doc: LibrarySchemaDoc } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Schema must be valid JSON" };
  }
  const result = librarySchemaDocSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? "Invalid schema" };
  }
  return { ok: true, doc: result.data };
}
