/** Cookie names and form/session helpers for HTTP routes. */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { AppConfig } from "../config.ts";
import type { AccountGuard } from "../auth/account-guard.ts";
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

export const SESSION_COOKIE = "mcpencode_session";
export const OAUTH_COOKIE = "mcpencode_oauth";

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
  // Tests and tools may build a partial config; no public address means plain HTTP.
  const secure = config.publicBaseUrl?.startsWith("https://") ?? false;
  const token = readCookie(req.headers, SESSION_COOKIE, { secure });
  if (!token) return undefined;
  const session = await readSession(token, config.sessionSecret);
  if (!session) return undefined;
  let role = session.role;
  // Built-in accounts: a disabled or demoted account loses its session at once,
  // not when the cookie expires. The role comes from the account, not the cookie.
  const guard = req.app?.locals?.accountGuard as AccountGuard | undefined;
  if (guard) {
    const check = await guard(session.sub, session.issuedAt);
    if (!check.allowed) return undefined;
    role = check.role;
  }
  return {
    ...accessFromIdentity({ sub: session.sub, clientId: session.clientId, role }),
    csrf: session.csrf,
  };
}

/** Constant-time compare of two secrets; an empty value never matches. */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** CSRF token from the X-CSRF-Token header, for requests whose body is not parsed yet. */
export function csrfHeader(req: Request): string {
  const value = req.headers["x-csrf-token"];
  return typeof value === "string" ? value : "";
}

export function requireCsrf(req: Request, csrf: string): boolean {
  const provided = formString(req.body, "csrf") || csrfHeader(req);
  return tokensMatch(provided, csrf);
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
