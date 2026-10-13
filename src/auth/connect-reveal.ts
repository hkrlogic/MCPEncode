/**
 * One-time reveal of a new Connect token.
 *
 * The database stores only the SHA-256 of a Connect token. Right after Create,
 * Copy, or Rotate the plaintext is held in memory for the publisher's next
 * library page load, then forgotten. The cookie carries a random reveal id,
 * not the token.
 */
import { randomBytes } from "node:crypto";

export const CONNECT_REVEAL_COOKIE = "mcpencode_connect_reveal";

const REVEAL_TTL_MS = 2 * 60 * 1000;

type Reveal = { libraryId: string; sub: string; token: string; expiresAt: number };

const reveals = new Map<string, Reveal>();

function sweep(now: number): void {
  for (const [id, row] of reveals) {
    if (row.expiresAt <= now) reveals.delete(id);
  }
  while (reveals.size > 50) {
    const oldest = reveals.keys().next().value;
    if (!oldest) break;
    reveals.delete(oldest);
  }
}

/** Remember a plaintext Connect token until the publisher's next library page load. */
export function stashConnectReveal(input: { libraryId: string; sub: string; token: string }): string {
  const now = Date.now();
  sweep(now);
  const id = randomBytes(32).toString("base64url");
  reveals.set(id, { ...input, expiresAt: now + REVEAL_TTL_MS });
  return id;
}

/** Return the plaintext once. Mismatch, expiry, or a second read returns nothing and consumes the id. */
export function takeConnectReveal(id: string, libraryId: string, sub: string): string | undefined {
  const row = reveals.get(id);
  if (!row) return undefined;
  reveals.delete(id);
  if (row.expiresAt <= Date.now()) return undefined;
  if (row.libraryId !== libraryId || row.sub !== sub) return undefined;
  return row.token;
}
