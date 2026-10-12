/**
 * Per-address rate limit for the library MCP routes (MCP_RATE_LIMIT_PER_MINUTE).
 *
 * The address is req.ip, so it follows TRUST_PROXY: with no trusted proxy it is
 * the socket address; behind trusted proxies it is the first untrusted hop of
 * X-Forwarded-For. IPv6 clients are counted per /56, IPv4-mapped addresses as
 * their IPv4 address. Counts live in memory, per process.
 */
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

export const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

export function mcpRateLimit(perMinute: number): RequestHandler | undefined {
  if (perMinute <= 0) return undefined;
  return rateLimit({
    windowMs: MCP_RATE_LIMIT_WINDOW_MS,
    limit: perMinute,
    // RateLimit-Policy and RateLimit (IETF draft 8); Retry-After on a 429.
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: "mcp",
    // CORS preflights carry no credentials and do no work.
    skip: (req) => req.method === "OPTIONS",
    validate: {
      // With TRUST_PROXY off, X-Forwarded-For is ignored on purpose: the client
      // could set it to anything. Seeing the header is not a misconfiguration.
      xForwardedForHeader: false,
      // Express does not read Forwarded (RFC 7239); like X-Forwarded-For
      // without a trusted proxy, ignoring it is the safe choice.
      forwardedHeader: false,
    },
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Too many requests from this address. The limit is ${perMinute} per minute; wait and retry (see Retry-After).`,
        },
        id: null,
      });
    },
  });
}
