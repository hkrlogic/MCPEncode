import { z } from "zod/v4";
import { proposeTableInputSchema } from "./table-proposal.ts";

/** Max length for items.entity_key (stable agent upsert id inside one library). */
export const MAX_ENTITY_KEY = 120;

/**
 * Normalize a stable entity key.
 * Empty/whitespace → null. Otherwise lowercase slug-like token.
 */
export function normalizeEntityKey(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return key.slice(0, MAX_ENTITY_KEY);
}

/** True when the key is allowed to be stored (null/empty already handled). */
export function isValidEntityKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9._:/-]{0,119}$/.test(key);
}

export const entityKeySchema = z
  .string()
  .trim()
  .max(MAX_ENTITY_KEY, `Entity key must be ${MAX_ENTITY_KEY} characters or fewer`)
  .refine((value) => !value || isValidEntityKey(value.toLowerCase()), {
    message:
      "Entity key must start with a letter or digit and use only letters, digits, and . _ : / -",
  })
  .optional()
  .describe(
    "Stable id for this real-world entity inside the library (for example host:contoso-01). Prefer this for Direct upserts.",
  );

/** Shared item shape for the HTML form and MCP tools. */
export const itemInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer"),
  body: z.string().max(50_000, "Item is too long").default(""),
  labels: z
    .array(z.string().trim().min(1).max(40))
    .max(20, "At most 20 labels")
    .default([]),
  entity_key: entityKeySchema,
});

export type ItemInput = z.infer<typeof itemInputSchema>;

export const listQuerySchema = z.object({
  library_id: z.string().uuid().optional(),
  library_name: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  entity_key: z.string().trim().min(1).max(MAX_ENTITY_KEY).optional(),
  // UI may page up to 200; MCP tools keep a tighter max in their own schemas.
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const libraryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer"),
});

/** Schema starters an agent or API must pick when adding a library. */
export const LIBRARY_SCHEMA_STARTERS = ["general", "policy", "procedure"] as const;

/**
 * How item writes become visible on a library.
 * reviewed = Pending until a human Publishes (default).
 * direct = successful create/update is Published immediately.
 */
export const LIBRARY_WRITE_MODES = ["reviewed", "direct"] as const;
export type LibraryWriteMode = (typeof LIBRARY_WRITE_MODES)[number];

export function isLibraryWriteMode(value: string): value is LibraryWriteMode {
  return (LIBRARY_WRITE_MODES as readonly string[]).includes(value);
}

/** MCP / API shape for adding a library. Schema is chosen only after the design conversation. */
export const createLibraryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer")
    .describe("Library name the human confirmed"),
  schema: z
    .enum(LIBRARY_SCHEMA_STARTERS)
    .describe(
      "policy or procedure only after the human confirmed that fixed shape. general when table is set — general is the placeholder until they approve the table.",
    ),
  write_mode: z
    .enum(LIBRARY_WRITE_MODES)
    .describe(
      "reviewed = items stay Pending until a human Publishes. direct = saves are live immediately. Ask the human which one; do not guess.",
    ),
  table: proposeTableInputSchema
    .optional()
    .describe(
      "Confirmed table design. Send only with schema general, and only after the human confirmed the columns. Stored as a proposal they Approve in the publisher. Not saved as items.",
    ),
});

export type CreateLibraryInput = z.infer<typeof createLibraryInputSchema>;

/** Parse a form labels field (`ops, poc`) into the stored string array. */
export function parseLabelField(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of raw.split(",")) {
    const label = part.trim().toLowerCase();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label.slice(0, 40));
    if (labels.length >= 20) break;
  }
  return labels;
}

export function excerptOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}
