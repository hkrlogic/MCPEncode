/** Per-library MCP resource URL. Embedded tokens use this as the audience. */

import { timingSafeEqual } from "node:crypto";

const LIBRARY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL segment after /mcp/. Hex backfill (64) or base64url from Node (~43). */
const CONNECT_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export function isLibraryId(value: string): boolean {
  return LIBRARY_ID.test(value);
}

export function isConnectToken(value: string): boolean {
  return CONNECT_TOKEN.test(value);
}

/** Constant-time compare so a wrong guess does not leak timing. */
export function connectTokensMatch(expected: string, provided: string): boolean {
  if (!isConnectToken(expected) || !isConnectToken(provided)) return false;
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

/**
 * MCP address for one library. Includes the connect token so the link can be
 * rotated without changing who is on the access list.
 */
export function libraryMcpUrl(
  publicBaseUrl: string,
  libraryId: string,
  connectToken: string,
): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/libraries/${libraryId}/mcp/${connectToken}`;
}
