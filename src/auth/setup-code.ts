/**
 * Setup code for the first account.
 *
 * The first account is SA: it manages people and every library. On a machine
 * only you can reach, "first visit creates the account" is fine. On a public
 * address, whoever opens the page first would own the instance, so the page
 * asks for a code that only the operator has: SETUP_TOKEN if set, otherwise a
 * random one printed once to the server log at startup.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SETUP_TOKEN_MIN_LENGTH = 16;

/** 96 random bits, base64url. Printed to the log when SETUP_TOKEN is not set. */
export function newSetupCode(): string {
  return randomBytes(12).toString("base64url");
}

/** Constant-time compare on digests, so length and content do not leak through timing. */
export function setupCodeMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented.trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
