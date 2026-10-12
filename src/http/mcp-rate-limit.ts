/**
 * Per-address rate limit for the library MCP routes (MCP_RATE_LIMIT_PER_MINUTE).
 * IPv6 clients are counted per /56, IPv4-mapped addresses as their IPv4 address.
 */
import type { RequestHandler } from "express";
import { addressRateLimit } from "./rate-limit.ts";

export const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

export function mcpRateLimit(perMinute: number): RequestHandler | undefined {
  return addressRateLimit({
    limit: perMinute,
    windowMs: MCP_RATE_LIMIT_WINDOW_MS,
    identifier: "mcp",
    ipv6Subnet: 56,
    // CORS preflights carry no credentials and do no work.
    skip: (req) => req.method === "OPTIONS",
    send: (res) => {
      res.json({
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
