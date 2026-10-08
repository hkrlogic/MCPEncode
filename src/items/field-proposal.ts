/**
 * One optional field proposed over MCP. Not on the live schema until a
 * publisher Approves it in the portal. Agents cannot approve or reject.
 */
import { z } from "zod/v4";
import type { LibrarySchema, SchemaFieldDef, SchemaFieldType } from "./library-schema.ts";

/** Same column types as table proposals — keep add-ons simple. */
export const FIELD_PROPOSAL_TYPES = ["text", "date", "longtext"] as const;
export type FieldProposalType = (typeof FIELD_PROPOSAL_TYPES)[number];

/** Total fields on a library schema (starter fields + approved add-ons). */
export const MAX_LIBRARY_FIELDS = 12;

const MAX_FIELD_LABEL = 40;

const RESERVED_KEYS = new Set([
  "name",
  "labels",
  "summary",
  "body",
  "id",
  "status",
  "rule",
  "library_id",
  "entity_key",
]);

/** Stored on libraries.field_proposal. */
export type FieldProposal = {
  key: string;
  label: string;
  type: FieldProposalType;
  /** Always false for add-ons so old items stay honest. */
  required: false;
  proposedBy: string;
  proposedAt: number;
};

export const proposeFieldInputSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Field label is required")
    .max(MAX_FIELD_LABEL, `Field labels must be ${MAX_FIELD_LABEL} characters or fewer`)
    .describe("Human label for the new optional field"),
  type: z
    .enum(FIELD_PROPOSAL_TYPES)
    .describe("text, date (YYYY-MM-DD), or longtext"),
});

export type ProposeFieldInput = z.infer<typeof proposeFieldInputSchema>;

/** After checks, before the server stamps who proposed it. */
export type FieldProposalDraft = Omit<FieldProposal, "proposedBy" | "proposedAt">;

function fieldKey(label: string): string {
  const ascii = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let base = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = base ? `field_${base}` : "field";
  return base.slice(0, 32);
}

function cleanLabel(label: string): string | undefined {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_FIELD_LABEL) return undefined;
  if (/[\u0000-\u001f<>]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Turn a tool payload into one optional field draft.
 * proposedBy is set by the server from the signed-in subject.
 */
export function normalizeFieldProposal(
  input: ProposeFieldInput,
  schema: LibrarySchema,
): { ok: true; draft: FieldProposalDraft } | { ok: false; message: string } {
  const label = cleanLabel(input.label);
  if (!label) {
    return { ok: false, message: "Field needs a short label without raw control characters." };
  }
  if (input.type !== "text" && input.type !== "date" && input.type !== "longtext") {
    return { ok: false, message: "Field type must be text, date, or longtext." };
  }
  if (schema.fields.length >= MAX_LIBRARY_FIELDS) {
    return {
      ok: false,
      message: `This library already has ${MAX_LIBRARY_FIELDS} fields. Remove is not allowed — copy the library template to change shape, or stop here.`,
    };
  }
  const key = fieldKey(label);
  if (RESERVED_KEYS.has(key)) {
    return {
      ok: false,
      message: `Field "${label}" clashes with a reserved item field. Pick another name.`,
    };
  }
  if (schema.fields.some((field) => field.key === key)) {
    return {
      ok: false,
      message: `Field "${label}" already exists on this library (key ${key}). Existing fields cannot be changed.`,
    };
  }
  if (schema.fields.some((field) => field.label.toLowerCase() === label.toLowerCase())) {
    return {
      ok: false,
      message: `Field "${label}" already exists on this library. Existing fields cannot be changed.`,
    };
  }
  return { ok: true, draft: { key, label, type: input.type, required: false } };
}

/** Append an approved proposal onto the live schema. Does not rename or remove. */
export function schemaWithApprovedField(
  schema: LibrarySchema,
  proposal: FieldProposal,
): LibrarySchema {
  const field: SchemaFieldDef = {
    key: proposal.key,
    label: proposal.label,
    type: proposal.type as SchemaFieldType,
    required: false,
    kind: proposal.type === "longtext" ? "body" : "control",
  };
  if (proposal.type === "text") field.max = 200;
  if (proposal.type === "longtext") field.max = 8_000;
  return { ...schema, fields: [...schema.fields, field] };
}

const STORED_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Read libraries.field_proposal. Unreadable JSON stays rejectable. */
export function parseStoredFieldProposal(
  raw: unknown,
): { proposal: FieldProposal | null; unreadable: boolean } {
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
  const key = typeof row.key === "string" ? row.key : "";
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const type = row.type;
  if (!STORED_KEY.test(key) || RESERVED_KEYS.has(key)) {
    return { proposal: null, unreadable: true };
  }
  if (!label || label.length > MAX_FIELD_LABEL || /[\u0000-\u001f<>]/.test(label)) {
    return { proposal: null, unreadable: true };
  }
  if (type !== "text" && type !== "date" && type !== "longtext") {
    return { proposal: null, unreadable: true };
  }
  // Add-ons must stay optional even if bad JSON claimed required.
  return {
    proposal: {
      key,
      label,
      type,
      required: false,
      proposedBy: typeof row.proposedBy === "string" ? row.proposedBy.slice(0, 255) : "",
      proposedAt: typeof row.proposedAt === "number" && Number.isFinite(row.proposedAt) ? row.proposedAt : 0,
    },
    unreadable: false,
  };
}
