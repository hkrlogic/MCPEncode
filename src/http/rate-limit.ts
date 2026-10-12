/**
 * One helper for every per-address rate limit (library MCP routes, OAuth
 * register and authorize). The address is req.ip, so it follows TRUST_PROXY.
 * Counts live in memory, per process.
 */
import type { Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";

export type AddressRateLimit = {
  /** Requests per window. 0 or less turns the limit off (returns undefined). */
  limit: number;
  windowMs: number;
  /** Shown in the RateLimit-Policy header. */
  identifier: string;
  /** IPv6 prefix length counted as one address. */
  ipv6Subnet: number;
  /** Writes the 429 body; the status is already set. */
  send: (res: Response) => void;
  skip?: (req: Request) => boolean;
};

export function addressRateLimit(options: AddressRateLimit): RequestHandler | undefined {
  if (!options.limit || options.limit <= 0) return undefined;
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    // RateLimit-Policy and RateLimit (IETF draft 8); Retry-After on a 429.
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: options.identifier,
    ipv6Subnet: options.ipv6Subnet,
    skip: options.skip,
    validate: {
      // With TRUST_PROXY off, X-Forwarded-For is ignored on purpose: the client
      // could set it to anything. Express does not read Forwarded (RFC 7239).
      xForwardedForHeader: false,
      forwardedHeader: false,
    },
    handler: (_req, res, _next, limitOptions) => {
      res.status(limitOptions.statusCode);
      options.send(res);
    },
  });
}
