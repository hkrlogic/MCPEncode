/** Cookie names and form/session helpers for HTTP routes. */
import type { Request, Response } from "express";
import type { AppConfig } from "../config.ts";
import { accessFromIdentity, type Access } from "../auth/rbac.ts";
import { readSession } from "../auth/session.ts";
import {
  isLibraryWriteMode,
  itemInputSchema,
  parseLabelField,
  type LibraryWriteMode,
} from "../items/schema.ts";
import type { CustomFieldRow } from "../items/custom-schema.ts";
import { isPlainGeneral, type ItemWriteInput, type LibrarySchema } from "../items/library-schema.ts";
import {
  itemForLibrary,
  type LibraryTemplate,
} from "../items/templates.ts";
import { combineSummaryAndBody } from "../markdown/table.ts";
import { readCookie } from "./cookies.ts";

export const SESSION_COOKIE = "mpos_session";
export const OAUTH_COOKIE = "mpos_oauth";

export function setCookies(res: Response, headers: string[]): void {
  res.setHeader("Set-Cookie", headers);
}

export function formString(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Custom field rows from Add library.
 * Every row posts a label, a type, and required yes/no, aligned by index.
 */
export function postedCustomFields(
  body: unknown,
): { ok: true; rows: CustomFieldRow[] } | { ok: false; message: string } {
  const labels = formStrings(body, "field_label");
  const types = formStrings(body, "field_type");
  const required = formStrings(body, "field_required");
  const count = Math.max(labels.length, types.length, required.length);
  if (labels.length !== count || types.length !== count || required.length !== count) {
    return { ok: false, message: "Each field needs a label, a type, and whether it is required." };
  }
  return {
    ok: true,
    rows: labels.map((label, index) => ({
      label,
      type: types[index] ?? "",
      required: required[index] === "required",
    })),
  };
}

/** Repeated form keys. A single value is a one-item list. */
export function formStrings(body: unknown, key: string): string[] {
  if (!body || typeof body !== "object") return [];
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function sessionAccess(
  req: Request,
  config: AppConfig,
): Promise<(Access & { csrf: string }) | undefined> {
  const token = readCookie(req.headers, SESSION_COOKIE);
  if (!token) return undefined;
  const session = await readSession(token, config.sessionSecret);
  if (!session) return undefined;
  return { ...accessFromIdentity(session), csrf: session.csrf };
}

export function requireCsrf(req: Request, csrf: string): boolean {
  const fromForm = formString(req.body, "csrf");
  const fromHeader = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : "";
  const provided = fromForm || fromHeader;
  return Boolean(provided) && provided === csrf;
}

export function parseItem(body: unknown) {
  return itemInputSchema.safeParse({
    name: formString(body, "name"),
    body: combineSummaryAndBody(
      formString(body, "summary"),
      [formString(body, "body"), formString(body, "description")].filter((part) => part.trim()).join("\n\n"),
    ),
    labels: parseLabelField(formString(body, "labels")),
    entity_key: formString(body, "entity_key"),
  });
}

export function libraryTemplateFromForm(value: string): LibraryTemplate {
  if (value === "policy" || value === "procedure") return value;
  return "general";
}

/** Form must post write_mode. Returns undefined when missing or unknown. */
export function libraryWriteModeFromForm(value: string): LibraryWriteMode | undefined {
  const trimmed = value.trim();
  return isLibraryWriteMode(trimmed) ? trimmed : undefined;
}

/** Form fields for one library. Plain Documents keep markdown; structured schemas use columns. */
export function formToItemWrite(body: unknown, schema: LibrarySchema): ItemWriteInput {
  if (isPlainGeneral(schema)) {
    return {
      name: formString(body, "name"),
      body: combineSummaryAndBody(
        formString(body, "summary"),
        [formString(body, "body"), formString(body, "description")].filter((part) => part.trim()).join("\n\n"),
      ),
      labels: parseLabelField(formString(body, "labels")),
      entity_key: formString(body, "entity_key"),
    };
  }
  const input: ItemWriteInput = {
    name: formString(body, "name"),
    summary: formString(body, "summary"),
    labels: parseLabelField(formString(body, "labels")),
    entity_key: formString(body, "entity_key"),
  };
  for (const field of schema.fields) {
    input[field.key] = formString(body, field.key);
  }
  if (schema.fields.some((field) => field.key === "policy")) {
    input.rule = formString(body, "rule");
  }
  return input;
}

export function parseLibraryItem(
  body: unknown,
  library: { template: LibraryTemplate; schema: LibrarySchema },
) {
  if (isPlainGeneral(library.schema)) {
    return parseItem(body);
  }
  const saved = itemForLibrary(library.schema, formToItemWrite(body, library.schema));
  if (!saved.ok) {
    return { success: false as const, error: { issues: [{ message: saved.message }] } };
  }
  return { success: true as const, data: saved.item };
}
