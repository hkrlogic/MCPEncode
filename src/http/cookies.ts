import type { IncomingHttpHeaders } from "node:http";

type CookieScope = { secure?: boolean; path?: string };

/**
 * Cookie name with the browser-enforced prefix on HTTPS. A __Host- cookie
 * must be Secure, Path=/ and carry no Domain, so a neighbouring subdomain
 * cannot plant or overwrite it. Path-scoped cookies get __Secure- (Secure
 * required). Plain HTTP (local use) keeps the bare name: browsers refuse
 * prefixed cookies without Secure.
 */
export function cookieName(name: string, scope: CookieScope = {}): string {
  if (!scope.secure) return name;
  return (scope.path ?? "/") === "/" ? `__Host-${name}` : `__Secure-${name}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    // A malformed %-escape (from some other app on this host, or a tampered
    // header) skips that cookie instead of failing the whole request.
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // ignored
    }
  }
  return out;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge?: number; httpOnly?: boolean; path?: string; clear?: boolean; secure?: boolean } = {},
): string {
  const parts = [
    `${cookieName(name, options)}=${options.clear ? "" : encodeURIComponent(value)}`,
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

/** Read a cookie set by cookieHeader with the same secure/path options. */
export function readCookie(headers: IncomingHttpHeaders, name: string, scope: CookieScope = {}): string | undefined {
  return parseCookies(typeof headers.cookie === "string" ? headers.cookie : undefined)[cookieName(name, scope)];
}
