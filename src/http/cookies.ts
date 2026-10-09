import type { IncomingHttpHeaders } from "node:http";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge?: number; httpOnly?: boolean; path?: string; clear?: boolean; secure?: boolean } = {},
): string {
  const parts = [
    `${name}=${options.clear ? "" : encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.clear) {
    parts.push("Max-Age=0");
  } else if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  return parts.join("; ");
}

export function readCookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  return parseCookies(typeof headers.cookie === "string" ? headers.cookie : undefined)[name];
}
