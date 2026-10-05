import { z } from "zod/v4";

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
});

export type ItemInput = z.infer<typeof itemInputSchema>;

export const listQuerySchema = z.object({
  library_id: z.string().uuid().optional(),
  library_name: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
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

/** MCP / API shape for adding a library. */
export const createLibraryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer"),
  // Optional (not .default) — some MCP clients mishandle JSON Schema defaults.
  template: z.enum(["general", "policy", "procedure"]).optional(),
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
