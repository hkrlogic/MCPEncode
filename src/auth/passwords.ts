/** Password hashing for accounts stored in this app. */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** OWASP-aligned interactive login cost. A stored hash cannot raise this. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function usernameError(username: string): string | undefined {
  if (!username) return "Username is required.";
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must start with a letter or digit and use only letters, digits, and . _ -";
  }
  return undefined;
}

export function passwordError(password: string): string | undefined {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Password is too long.";
  return undefined;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/**
 * True when password matches the stored scrypt string.
 * A malformed or oversized hash returns false without running scrypt,
 * so a crafted row cannot pin the process.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > SCRYPT_N || r < 1 || r > SCRYPT_R || p < 1 || p > SCRYPT_P) return false;
  const salt = decode(parts[4] ?? "");
  const expected = decode(parts[5] ?? "");
  if (!salt || !expected || salt.length < 8 || expected.length !== KEY_LENGTH) return false;
  const actual = (await scryptAsync(password, salt, expected.length, { N: n, r, p })) as Buffer;
  return timingSafeEqual(actual, expected);
}

function decode(value: string): Buffer | undefined {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}
