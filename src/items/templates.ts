import { z } from "zod/v4";
import { itemInputSchema, type ItemInput } from "./schema.ts";

/** Library types. A library picks one. Items in it keep that shape. */
export const LIBRARY_TEMPLATES = ["general", "policy", "procedure"] as const;
export type LibraryTemplate = (typeof LIBRARY_TEMPLATES)[number];

export function isLibraryTemplate(value: string): value is LibraryTemplate {
  return (LIBRARY_TEMPLATES as readonly string[]).includes(value);
}

/**
 * Closed Policy field set, in display order.
 * Document control first, then the statement. Agents must use these labels only.
 * This matches the block used on corporate and ISO-style policies:
 * who owns it, which version is in force, when it starts and must be reviewed,
 * why it exists, who it covers, and what it requires.
 */
export const POLICY_FIELDS = [
  { key: "owner", label: "Owner", kind: "control", required: true },
  { key: "approved_by", label: "Approved by", kind: "control", required: false },
  { key: "version", label: "Version", kind: "control", required: true },
  { key: "effective_date", label: "Effective date", kind: "control", required: true },
  { key: "review_date", label: "Review date", kind: "control", required: true },
  { key: "purpose", label: "Purpose", kind: "body", required: true },
  { key: "scope", label: "Scope", kind: "body", required: true },
  { key: "policy", label: "Policy", kind: "body", required: true },
  { key: "responsibilities", label: "Responsibilities", kind: "body", required: false },
  { key: "exceptions", label: "Exceptions", kind: "body", required: false },
  { key: "references", label: "References", kind: "body", required: false },
] as const;

export type PolicyFieldKey = (typeof POLICY_FIELDS)[number]["key"];

const isoDate = (label: string) =>
  z
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

const optionalText = (max: number) => z.string().trim().max(max).default("");

export const policyItemSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer"),
    summary: z.string().trim().min(1, "Summary is required").max(160, "Summary must be 160 characters or fewer"),
    owner: z.string().trim().min(1, "Owner is required").max(200, "Owner must be 200 characters or fewer"),
    approved_by: optionalText(200),
    version: z
      .string()
      .trim()
      .min(1, "Version is required")
      .max(20, "Version must be 20 characters or fewer")
      .regex(/^\d+(\.\d+){0,2}$/, "Version must look like 1.0"),
    effective_date: isoDate("Effective date"),
    review_date: isoDate("Review date"),
    purpose: z.string().trim().min(1, "Purpose is required").max(8_000, "Purpose is too long"),
    scope: z.string().trim().min(1, "Scope is required").max(8_000, "Scope is too long"),
    policy: z.string().trim().min(1, "Policy is required").max(20_000, "Policy is too long"),
    responsibilities: optionalText(12_000),
    exceptions: optionalText(8_000),
    references: optionalText(8_000),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .refine((value) => value.review_date >= value.effective_date, {
    message: "Review date must be on or after the effective date",
    path: ["review_date"],
  });

export type PolicyItemInput = z.infer<typeof policyItemSchema>;

export type PolicyDetails = {
  owner: string;
  approved_by: string;
  version: string;
  effective_date: string;
  review_date: string;
  purpose: string;
  scope: string;
  policy: string;
  responsibilities: string;
  exceptions: string;
  references: string;
};

export const POLICY_FIELD_MESSAGE =
  "This library is Policy. Send name, summary, owner, version (for example 1.0), effective_date (YYYY-MM-DD), review_date (YYYY-MM-DD), purpose, scope, and policy. Optional: approved_by, responsibilities, exceptions, references. Do not invent fields.";

/** Canonical Policy text. Every label is always present so the field set stays closed. */
export function formatPolicy(input: PolicyDetails): string {
  const control = POLICY_FIELDS.filter((field) => field.kind === "control")
    .map((field) => `${field.label}: ${input[field.key]}`)
    .join("\n");
  const body = POLICY_FIELDS.filter((field) => field.kind === "body")
    .map((field) => {
      const value = input[field.key].trim();
      return value ? `${field.label}:\n${value}` : `${field.label}:`;
    })
    .join("\n\n");
  return ["Template: Policy", control, "", body].join("\n");
}

export function policyControl(details: PolicyDetails): { label: string; value: string }[] {
  return POLICY_FIELDS.filter((field) => field.kind === "control" && details[field.key]).map((field) => ({
    label: field.label,
    value: details[field.key],
  }));
}

export function policyBody(details: PolicyDetails): { label: string; text: string }[] {
  return POLICY_FIELDS.filter((field) => field.kind === "body" && details[field.key].trim()).map((field) => ({
    label: field.label,
    text: details[field.key].trim(),
  }));
}

type WriteFields = {
  name: string;
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
};

export type SavedItem = ItemInput & { summary?: string; details?: string | null };

/** Turn a tool or form payload into the stored item for this library type. */
export function itemForLibrary(
  template: LibraryTemplate,
  input: WriteFields,
): { ok: true; item: SavedItem } | { ok: false; message: string } {
  if (template === "policy") {
    const parsed = policyItemSchema.safeParse({
      name: input.name,
      summary: input.summary ?? "",
      owner: input.owner ?? "",
      approved_by: input.approved_by ?? "",
      version: input.version ?? "",
      effective_date: input.effective_date ?? "",
      review_date: input.review_date ?? "",
      purpose: input.purpose ?? "",
      scope: input.scope ?? "",
      policy: input.policy?.trim() || input.rule?.trim() || "",
      responsibilities: input.responsibilities ?? "",
      exceptions: input.exceptions ?? "",
      references: input.references ?? "",
      labels: input.labels ?? [],
    });
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "Invalid policy";
      return { ok: false, message: `${POLICY_FIELD_MESSAGE} ${detail}` };
    }
    const details: PolicyDetails = {
      owner: parsed.data.owner,
      approved_by: parsed.data.approved_by,
      version: parsed.data.version,
      effective_date: parsed.data.effective_date,
      review_date: parsed.data.review_date,
      purpose: parsed.data.purpose,
      scope: parsed.data.scope,
      policy: parsed.data.policy,
      responsibilities: parsed.data.responsibilities,
      exceptions: parsed.data.exceptions,
      references: parsed.data.references,
    };
    return {
      ok: true,
      item: {
        name: parsed.data.name,
        body: formatPolicy(details),
        labels: parsed.data.labels,
        summary: parsed.data.summary,
        details: JSON.stringify(details),
      },
    };
  }
  if (template === "procedure") {
    const parsed = procedureItemSchema.safeParse({
      name: input.name,
      summary: input.summary ?? "",
      owner: input.owner ?? "",
      related_policy: input.related_policy ?? "",
      when_to_use: input.when_to_use ?? "",
      steps: input.steps ?? "",
      who: input.who ?? "",
      labels: input.labels ?? [],
    });
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "Invalid procedure";
      return { ok: false, message: `${PROCEDURE_FIELD_MESSAGE} ${detail}` };
    }
    const details: ProcedureDetails = {
      owner: parsed.data.owner,
      related_policy: parsed.data.related_policy,
      when_to_use: parsed.data.when_to_use,
      steps: parsed.data.steps,
      who: parsed.data.who,
    };
    return {
      ok: true,
      item: {
        name: parsed.data.name,
        body: formatProcedure(details),
        labels: parsed.data.labels,
        summary: parsed.data.summary,
        details: JSON.stringify(details),
      },
    };
  }
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

/**
 * Closed Procedure field set. A procedure carries out a policy:
 * who owns the steps, which policy they serve, when to start, the steps, and who does them.
 */
export const PROCEDURE_FIELDS = [
  { key: "owner", label: "Owner", kind: "control" },
  { key: "related_policy", label: "Related policy", kind: "control" },
  { key: "when_to_use", label: "When to use it", kind: "body" },
  { key: "steps", label: "Steps", kind: "body" },
  { key: "who", label: "Who does each step", kind: "body" },
] as const;

export type ProcedureDetails = {
  owner: string;
  related_policy: string;
  when_to_use: string;
  steps: string;
  who: string;
};

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);

export const procedureItemSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer"),
  summary: z.string().trim().min(1, "Summary is required").max(160, "Summary must be 160 characters or fewer"),
  owner: z.string().trim().min(1, "Owner is required").max(200, "Owner must be 200 characters or fewer"),
  related_policy: z
    .string()
    .trim()
    .min(1, "Related policy is required")
    .max(200, "Related policy must be 200 characters or fewer"),
  when_to_use: requiredText("When to use it", 8_000),
  steps: requiredText("Steps", 20_000),
  who: requiredText("Who does each step", 8_000),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const PROCEDURE_FIELD_MESSAGE =
  "This library is Procedure. Send name, summary, owner, related_policy, when_to_use, steps, and who. Do not invent fields.";

/** Canonical Procedure text. Every label is always present so the field set stays closed. */
export function formatProcedure(input: ProcedureDetails): string {
  const control = PROCEDURE_FIELDS.filter((field) => field.kind === "control")
    .map((field) => `${field.label}: ${input[field.key]}`)
    .join("\n");
  const body = PROCEDURE_FIELDS.filter((field) => field.kind === "body")
    .map((field) => `${field.label}:\n${input[field.key].trim()}`)
    .join("\n\n");
  return ["Template: Procedure", control, "", body].join("\n");
}

export function procedureControl(details: ProcedureDetails): { label: string; value: string }[] {
  return PROCEDURE_FIELDS.filter((field) => field.kind === "control" && details[field.key]).map((field) => ({
    label: field.label,
    value: details[field.key],
  }));
}

export function procedureBody(details: ProcedureDetails): { label: string; text: string }[] {
  return PROCEDURE_FIELDS.filter((field) => field.kind === "body" && details[field.key].trim()).map((field) => ({
    label: field.label,
    text: details[field.key].trim(),
  }));
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function parsePolicyDetails(raw: string | null | undefined): PolicyDetails | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const owner = textField(record, "owner");
    const effective_date = textField(record, "effective_date");
    const policy = textField(record, "policy") || textField(record, "rule");
    if (!owner || !effective_date || !policy) return undefined;
    return {
      owner,
      approved_by: textField(record, "approved_by"),
      version: textField(record, "version"),
      effective_date,
      review_date: textField(record, "review_date"),
      purpose: textField(record, "purpose"),
      scope: textField(record, "scope"),
      policy,
      responsibilities: textField(record, "responsibilities"),
      exceptions: textField(record, "exceptions"),
      references: textField(record, "references"),
    };
  } catch {
    return undefined;
  }
}

export function parseProcedureDetails(raw: string | null | undefined): ProcedureDetails | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const owner = textField(record, "owner");
    const related_policy = textField(record, "related_policy");
    const when_to_use = textField(record, "when_to_use");
    const steps = textField(record, "steps");
    const who = textField(record, "who");
    if (!owner || !related_policy || !when_to_use || !steps || !who) return undefined;
    return { owner, related_policy, when_to_use, steps, who };
  } catch {
    return undefined;
  }
}
