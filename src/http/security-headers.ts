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

export function securityHeaders(options: { https: boolean }) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Content-Security-Policy", ENFORCED_CSP);
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
