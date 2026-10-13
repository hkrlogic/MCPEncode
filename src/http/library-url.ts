/** Per-library MCP resource URL. Embedded tokens use this as the audience. */

import { createHash, timingSafeEqual } from "node:crypto";

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

/** SHA-256 hex of a Connect token. The database stores only this. */
export function hashConnectToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Last four characters, shown as "…a1b2" so a publisher can tell links apart. Not the secret. */
export function connectTokenLast4(token: string): string {
  return token.slice(-4);
}

const HASH_HEX = /^[a-f0-9]{64}$/;
const DUMMY_HASH = hashConnectToken("connect-token-unset");

/**
 * True when the presented token hashes to the stored hash. Constant-time.
 * A malformed token or hash is a miss after the same hash-and-compare work.
 */
export function connectTokenMatchesHash(storedHash: string | null | undefined, provided: string): boolean {
  const wellFormed = isConnectToken(provided);
  const stored = storedHash?.trim().toLowerCase() ?? "";
  const validStored = HASH_HEX.test(stored);
  const actual = Buffer.from(hashConnectToken(provided), "hex");
  const expected = Buffer.from(validStored ? stored : DUMMY_HASH, "hex");
  const equal = timingSafeEqual(actual, expected);
  return wellFormed && validStored && equal;
}

/** Constant-time compare of two plaintext tokens (tests and one-time reveal checks). */
export function connectTokensMatch(expected: string, provided: string): boolean {
  if (!isConnectToken(expected) || !isConnectToken(provided)) return false;
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

/**
 * The Connect link with the secret replaced by "…" and its last four characters.
 * Safe to show on every page load; it does not connect.
 */
export function maskedLibraryMcpUrl(publicBaseUrl: string, libraryId: string, last4: string | null | undefined): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/libraries/${libraryId}/mcp/…${last4 ?? ""}`;
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

/**
 * The same library without the token in the path. Clients that can set
 * headers connect here and send the token in X-Library-Token, so it never
 * appears in a URL or an access log.
 */
export function libraryMcpBaseUrl(publicBaseUrl: string, libraryId: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/libraries/${libraryId}/mcp`;
}
