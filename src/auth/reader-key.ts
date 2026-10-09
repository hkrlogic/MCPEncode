/**
 * Per-library Reader key.
 *
 * A publisher creates one secret for a library. LibreChat (or any MCP client)
 * sends it as Authorization: Bearer. The connection is Reader: published items
 * only, no writes, no audit log, and no publisher UI session.
 *
 * The database stores SHA-256 only. The plaintext is shown once, then kept in
 * memory just long enough for the next page load to display it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";

/** Distinguishes a Reader key from an OAuth access token (those start with eyJ). */
export const READER_KEY_PREFIX = "mpr_";

/** 32 bytes, base64url, no padding. `mpr_` + 43 characters. */
const READER_KEY_PATTERN = /^mpr_[A-Za-z0-9_-]{43}$/;

/** Shown in the publisher so a person can recognize the active key. Not the secret. */
const VISIBLE_PREFIX_LENGTH = 12;

export const READER_KEY_CLIENT_ID = "library-reader-key";

/** Cookie that carries the one-time reveal id. The secret is not in the cookie. */
export const READER_REVEAL_COOKIE = "mpos_reader_reveal";

const REVEAL_TTL_MS = 2 * 60 * 1000;

/**
 * Compared when the library has no key, so a missing key takes the same
 * hash-and-compare time as a wrong key.
 */
const DUMMY_HASH = createHash("sha256").update("mpr_reader-key-unset").digest("hex");

type Reveal = {
  libraryId: string;
  sub: string;
  key: string;
  expiresAt: number;
};

const reveals = new Map<string, Reveal>();

export function readerKeySubject(libraryId: string): string {
  return `reader-key:${libraryId}`;
}

export function generateReaderKey(): string {
  return `${READER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** True only for the exact issued shape. Anything else is not a Reader key. */
export function isReaderKeyToken(token: string): boolean {
  return READER_KEY_PATTERN.test(token);
}

export function readerKeyPrefix(key: string): string {
  return key.slice(0, VISIBLE_PREFIX_LENGTH);
}

export function hashReaderKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * True when the presented key matches the stored hash.
 * A null or malformed hash is a miss. Comparison is constant-time.
 */
export function readerKeyMatches(presented: string, storedHash: string | null | undefined): boolean {
  const actual = Buffer.from(hashReaderKey(presented), "hex");
  const hex = storedHash && /^[a-f0-9]{64}$/.test(storedHash) ? storedHash : DUMMY_HASH;
  const expected = Buffer.from(hex, "hex");
  const equal = timingSafeEqual(actual, expected);
  return Boolean(storedHash) && storedHash === hex && equal;
}

/** Pull a single bearer token. Oversized headers are ignored. */
export function bearerFromAuthorization(header: string | undefined): string | undefined {
  if (!header || header.length > 512) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length > 80) return undefined;
  return token;
}

/**
 * AuthInfo for a key that already matched this library.
 * `token` is a label, not the secret — the secret must not ride along on the request.
 */
export function readerKeyAuthInfo(libraryId: string): AuthInfo {
  return {
    token: "reader-key",
    clientId: READER_KEY_CLIENT_ID,
    scopes: ["records.read"],
    extra: { sub: readerKeySubject(libraryId), role: "readonly", readerKey: true },
  };
}

function sweepReveals(now: number): void {
  for (const [id, row] of reveals) {
    if (row.expiresAt <= now) reveals.delete(id);
  }
  while (reveals.size > 50) {
    const oldest = reveals.keys().next().value;
    if (!oldest) break;
    reveals.delete(oldest);
  }
}

/** Remember a plaintext key until the publisher's next library page load. */
export function stashReaderKeyReveal(input: { libraryId: string; sub: string; key: string }): string {
  const now = Date.now();
  sweepReveals(now);
  const id = randomBytes(32).toString("base64url");
  reveals.set(id, {
    libraryId: input.libraryId,
    sub: input.sub,
    key: input.key,
    expiresAt: now + REVEAL_TTL_MS,
  });
  return id;
}

/**
 * Return the plaintext once. A mismatch, expiry, or second read returns nothing
 * and still consumes the id.
 */
export function takeReaderKeyReveal(id: string, libraryId: string, sub: string): string | undefined {
  const row = reveals.get(id);
  if (!row) return undefined;
  reveals.delete(id);
  if (row.expiresAt <= Date.now()) return undefined;
  if (row.libraryId !== libraryId || row.sub !== sub) return undefined;
  return row.key;
}
