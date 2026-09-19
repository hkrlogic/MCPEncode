import { z } from "zod/v4";

/** Shared item shape for the HTML form and MCP tools. */
export const itemInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer"),
  notes: z.string().max(50_000, "Item is too long").default(""),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20, "At most 20 labels")
    .default([]),
});

export type ItemInput = z.infer<typeof itemInputSchema>;

export const listQuerySchema = z.object({
  library_id: z.string().uuid().optional(),
  tag: z.string().trim().min(1).max(40).optional(),
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

/** Parse a form labels field (`ops, poc`) into the stored string array. */
export function parseTagField(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag.slice(0, 40));
    if (tags.length >= 20) break;
  }
  return tags;
}

export function excerptOf(notes: string, max = 160): string {
  const flat = notes.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}
