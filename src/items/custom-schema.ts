/**
 * Custom library schema built in the publisher (Add library → Custom).
 * Name, labels, and summary stay on every item. These fields are the rest.
 * Creating the library locks them. Later adds are still propose → Approve.
 */
import { FIELD_TYPE_MAX } from "./field-limits.ts";
import {
  FIELD_PROPOSAL_TYPES,
  MAX_FIELD_LABEL,
  MAX_LIBRARY_FIELDS,
  RESERVED_FIELD_KEYS,
  cleanFieldLabel,
  fieldKeyFromLabel,
  type FieldProposalType,
} from "./field-proposal.ts";
import type { LibrarySchema, SchemaFieldDef } from "./library-schema.ts";

export type CustomFieldRow = {
  label: string;
  type: string;
  required: boolean;
};

const FIELD_TYPES = new Set<string>(FIELD_PROPOSAL_TYPES);

function isFieldType(value: string): value is FieldProposalType {
  return FIELD_TYPES.has(value);
}

function fieldDef(label: string, key: string, type: FieldProposalType, required: boolean): SchemaFieldDef {
  const field: SchemaFieldDef = {
    key,
    label,
    type,
    required,
    kind: type === "longtext" ? "body" : "control",
  };
  if (type === "text") field.max = FIELD_TYPE_MAX.text;
  if (type === "longtext") field.max = FIELD_TYPE_MAX.longtext;
  return field;
}

/**
 * Turn posted field rows into a locked custom schema.
 * Blank labels are empty slots and are ignored. Filled rows are checked.
 */
export function customSchemaFromRows(
  rows: CustomFieldRow[],
): { ok: true; schema: LibrarySchema } | { ok: false; message: string } {
  if (rows.length > MAX_LIBRARY_FIELDS) {
    return {
      ok: false,
      message: `A custom schema can have ${MAX_LIBRARY_FIELDS} fields besides name, labels, and summary.`,
    };
  }

  const fields: SchemaFieldDef[] = [];
  const keys = new Set<string>();
  const labels = new Set<string>();

  for (const row of rows) {
    if (!row.label.trim()) continue;
    const label = cleanFieldLabel(row.label);
    if (!label) {
      return {
        ok: false,
        message: `Field labels must be ${MAX_FIELD_LABEL} characters or fewer, without markup.`,
      };
    }
    if (!isFieldType(row.type)) {
      return { ok: false, message: `Field "${label}" must be Text, Date, or Long text.` };
    }
    const key = fieldKeyFromLabel(label);
    if (RESERVED_FIELD_KEYS.has(key)) {
      return {
        ok: false,
        message: `“${label}” is already part of every item. Pick another field name.`,
      };
    }
    if (keys.has(key) || labels.has(label.toLowerCase())) {
      return {
        ok: false,
        message: `“${label}” repeats a field already on this list. Each field needs its own name.`,
      };
    }
    keys.add(key);
    labels.add(label.toLowerCase());
    fields.push(fieldDef(label, key, row.type, row.required));
  }

  return {
    ok: true,
    schema: { starter: "general", custom: true, fields },
  };
}
