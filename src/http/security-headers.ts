/**
 * Browser security headers for every response.
 *
 * - frame-ancestors / X-Frame-Options: nobody can put this app in a frame, which
 *   blocks click-jacking of the publisher buttons.
 * - base-uri, form-action, object-src: stop injected markup from re-pointing
 *   forms, relative links or plugins.
 * - Everything loads from this origin. Fonts and scripts come from our own files;
 *   no third party sees who opens a page.
 * - script-src is 'self' only: no inline script, no inline event handlers, no
 *   eval. Page behaviour (confirm prompts, copy buttons, menus) lives in
 *   public/page.js and reads data- attributes, so injected markup cannot run.
 *   style-src still allows inline styles; they cannot run code.
 * - HSTS is sent only when the public address is HTTPS.
 */
import type { NextFunction, Request, Response } from "express";

const BASE_DIRECTIVES = [
  "default-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

export const ENFORCED_CSP = [...BASE_DIRECTIVES, "script-src 'self'"].join("; ");

export function securityHeaders(options: { https: boolean; formAction?: readonly string[] }) {
  const csp = cspWithFormAction(options.formAction ?? []);
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (options.https) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  };
}

/**
 * The CSP form-action source that lets a form post land on an OAuth callback.
 * Chrome checks form-action on the redirect that follows a form post, so the
 * Allow / Deny form must name the callback's origin or the browser stops on the
 * consent page. http(s) callbacks give their exact origin; app schemes
 * (cursor:, com.example.app:) give the scheme form. Anything that would not be
 * a single safe CSP token gives undefined.
 */
export function formActionSource(redirectUri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return undefined;
  let source: string;
  if (scheme === "http" || scheme === "https") {
    const origin = parsed.origin;
    if (!origin || origin === "null") return undefined;
    source = origin;
  } else {
    source = `${scheme}:`;
  }
  // A CSP source list is split on whitespace and directives on ";". Refuse
  // anything outside the plain URL-origin alphabet.
  if (!/^[A-Za-z0-9+.:\-[\]/]+$/.test(source) || /[\s;,'"]/.test(source)) return undefined;
  return source;
}

/** The enforced policy with extra form-action sources (each from formActionSource). */
export function cspWithFormAction(extra: readonly (string | undefined)[]): string {
  const sources = extra.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (sources.length === 0) return ENFORCED_CSP;
  return ENFORCED_CSP.replace("form-action 'self'", `form-action 'self' ${[...new Set(sources)].join(" ")}`);
}
