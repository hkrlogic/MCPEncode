/** Cookie names and form/session helpers for HTTP routes. */
import type { Request, Response } from "express";
import type { AppConfig } from "../config.ts";
import { accessFromIdentity, type Access } from "../auth/rbac.ts";
import { readSession } from "../auth/session.ts";
import { itemInputSchema, parseLabelField } from "../items/schema.ts";
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
  });
}

export function libraryTemplateFromForm(value: string): LibraryTemplate {
  if (value === "policy" || value === "procedure") return value;
  return "general";
}

export function parseLibraryItem(body: unknown, template: LibraryTemplate) {
  if (template === "general") return parseItem(body);
  const saved = itemForLibrary(template, {
    name: formString(body, "name"),
    summary: formString(body, "summary"),
    owner: formString(body, "owner"),
    approved_by: formString(body, "approved_by"),
    version: formString(body, "version"),
    effective_date: formString(body, "effective_date"),
    review_date: formString(body, "review_date"),
    purpose: formString(body, "purpose"),
    scope: formString(body, "scope"),
    policy: formString(body, "policy"),
    responsibilities: formString(body, "responsibilities"),
    exceptions: formString(body, "exceptions"),
    references: formString(body, "references"),
    related_policy: formString(body, "related_policy"),
    when_to_use: formString(body, "when_to_use"),
    steps: formString(body, "steps"),
    who: formString(body, "who"),
    labels: parseLabelField(formString(body, "labels")),
  });
  if (!saved.ok) {
    return { success: false as const, error: { issues: [{ message: saved.message }] } };
  }
  return { success: true as const, data: saved.item };
}
