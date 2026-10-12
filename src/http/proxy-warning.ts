import type { RequestHandler } from "express";

export const FORWARDED_WITHOUT_TRUST_PROXY =
  "A request arrived with X-Forwarded-For but TRUST_PROXY is not set, so the header is ignored. " +
  "If MCPEncode runs behind a proxy, every visitor now shares the proxy's address: the sign-in throttle " +
  "and the register, authorize and MCP rate limits treat all clients as one address. " +
  "Set TRUST_PROXY to the number of proxy hops (e.g. 1) or the proxy addresses. See docs/deploy.md.";

/**
 * Logs one warning, the first time a request carries X-Forwarded-For while
 * TRUST_PROXY is off. Never changes the request.
 */
export function forwardedForWarning(warn: (message: string) => void = console.warn): RequestHandler {
  let warned = false;
  return (req, _res, next) => {
    if (!warned && req.headers["x-forwarded-for"] !== undefined) {
      warned = true;
      warn(FORWARDED_WITHOUT_TRUST_PROXY);
    }
    next();
  };
}
