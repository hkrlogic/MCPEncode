/**
 * Sign-in throttle for the built-in accounts.
 *
 * Three counters, each with its own allowance, then an exponential wait
 * (1s, 2s, 4s, … up to 15 minutes) after every further miss:
 *
 * - one username from one address (5 misses): stops guessing from one place;
 * - one address, any username (20 misses): stops spraying many usernames;
 * - one username from every address (100 misses): slows a distributed guess.
 *
 * Someone guessing at the SA from their own address only slows themselves
 * down; the SA signing in from elsewhere is not affected until a hundred
 * misses arrive from many addresses, and even then it is a short wait, not a
 * lock. An address this username signed in from successfully in the last 30
 * days skips the username-wide counter entirely, so a distributed guess cannot
 * keep the SA out of their usual place. Nothing is ever locked until an admin
 * acts.
 *
 * IPv6 addresses are counted per /64 (one household or customer), so an
 * attacker cannot step through a prefix to get fresh counters. Every map is
 * bounded: past MAX_ENTRIES, expired entries go first, then the oldest.
 *
 * An attempt is counted when it starts, before the password is hashed, so a
 * burst of parallel posts cannot all slip in under the limit. A successful
 * sign-in takes its own count back and clears that username's misses.
 * Counts live in this process only. Known-good addresses can be kept in a
 * KnownGoodStore (Postgres in production, migration 016) so a restart does not
 * forget them; they are stored as a SHA-256 of username + address key. Put a
 * per-address limit at the proxy as well (docs/deploy.md).
 */

export type SignInLimitOptions = {
  now?: () => number;
  /** Misses forgiven for one username from one address. */
  pairAllowance?: number;
  /** Misses forgiven from one address across all usernames. */
  addressAllowance?: number;
  /** Misses forgiven for one username across all addresses. */
  usernameAllowance?: number;
  /** First wait after the allowance; doubles each miss. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A counter with no new miss for this long starts over. */
  windowMs?: number;
  /** Keeps known-good addresses across restarts. Memory only when absent. */
  knownGoodStore?: KnownGoodStore;
};

/** Where known-good sign-in addresses survive a restart. Keys are already hashed. */
export type KnownGoodStore = {
  /** Entries with at >= since, at most limit, oldest first. */
  load(since: number, limit: number): Promise<{ key: string; at: number }[]>;
  /** Upsert one entry, drop entries older than expireBefore, keep at most limit. */
  remember(key: string, at: number, expireBefore: number, limit: number): Promise<void>;
};

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";

type Bucket = { count: number; last: number };

/** Most keys any one map holds. */
export const MAX_ENTRIES = 10_000;
/** How long a successful sign-in keeps that address known-good for the username. */
export const KNOWN_GOOD_MS = 30 * 24 * 60 * 60 * 1000;

/** The counting key for an address: IPv4 as is, IPv6 by its /64 prefix. */
export function addressKey(address: string): string {
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(plain) ? ipKeyGenerator(plain, 64) : plain;
}

const DEFAULTS = {
  pairAllowance: 5,
  addressAllowance: 20,
  usernameAllowance: 100,
  baseDelayMs: 1000,
  maxDelayMs: 15 * 60 * 1000,
  windowMs: 15 * 60 * 1000,
};

export class SignInLimit {
  private readonly now: () => number;
  private readonly settings: typeof DEFAULTS;
  private readonly pairs = new Map<string, Bucket>();
  private readonly addresses = new Map<string, Bucket>();
  private readonly usernames = new Map<string, Bucket>();
  /** SHA-256 of username + address key -> last successful sign-in. */
  private readonly knownGood = new Map<string, number>();
  private readonly knownGoodStore?: KnownGoodStore;

  constructor(options: SignInLimitOptions = {}) {
    const { knownGoodStore, ...rest } = options;
    this.now = rest.now ?? Date.now;
    this.settings = { ...DEFAULTS, ...stripUndefined(rest) };
    this.knownGoodStore = knownGoodStore;
  }

  /** Load the stored known-good addresses. Call once at startup. */
  async restore(): Promise<void> {
    if (!this.knownGoodStore) return;
    const rows = await this.knownGoodStore.load(this.now() - KNOWN_GOOD_MS, MAX_ENTRIES);
    for (const row of rows) {
      const current = this.knownGood.get(row.key);
      if (current === undefined || current < row.at) {
        this.knownGood.delete(row.key);
        this.knownGood.set(row.key, row.at);
      }
    }
    this.bound(this.knownGood, (last) => this.now() - last >= KNOWN_GOOD_MS);
  }

  /** True when this username or address must wait. Does not count anything. */
  blocked(username: string, rawAddress: string): boolean {
    const address = addressKey(rawAddress);
    const now = this.now();
    return (
      this.waiting(this.pairs, pairKey(username, address), this.settings.pairAllowance, now) ||
      this.waiting(this.addresses, address, this.settings.addressAllowance, now) ||
      (!this.isKnownGood(username, address, now) &&
        this.waiting(this.usernames, username, this.settings.usernameAllowance, now))
    );
  }

  /**
   * Call before checking the password. Returns false (and counts nothing) when
   * the caller must wait; otherwise counts the attempt as a miss until
   * succeed() takes it back.
   */
  begin(username: string, rawAddress: string): boolean {
    if (this.blocked(username, rawAddress)) return false;
    const address = addressKey(rawAddress);
    const now = this.now();
    this.add(this.pairs, pairKey(username, address), now);
    this.add(this.addresses, address, now);
    this.add(this.usernames, username, now);
    return true;
  }

  /** The attempt begun for this username and address signed in. */
  succeed(username: string, rawAddress: string): void {
    const address = addressKey(rawAddress);
    const key = pairKey(username, address);
    this.pairs.delete(key);
    const goodKey = knownGoodKey(username, address);
    const at = this.now();
    this.knownGood.delete(goodKey);
    this.knownGood.set(goodKey, at);
    this.bound(this.knownGood, (last) => this.now() - last >= KNOWN_GOOD_MS);
    this.knownGoodStore?.remember(goodKey, at, at - KNOWN_GOOD_MS, MAX_ENTRIES).catch((error: unknown) => {
      console.warn("Could not store a known-good sign-in address:", error instanceof Error ? error.message : error);
    });
    this.usernames.delete(username);
    const bucket = this.addresses.get(address);
    if (bucket) {
      bucket.count -= 1;
      if (bucket.count <= 0) this.addresses.delete(address);
    }
  }

  private isKnownGood(username: string, address: string, now: number): boolean {
    const last = this.knownGood.get(knownGoodKey(username, address));
    return last !== undefined && now - last < KNOWN_GOOD_MS;
  }

  /** Keep a map under MAX_ENTRIES: expired entries first, then the oldest (insertion order). */
  private bound<V>(map: Map<string, V>, expired: (value: V) => boolean): void {
    if (map.size <= MAX_ENTRIES) return;
    for (const [key, value] of map) if (expired(value)) map.delete(key);
    for (const key of map.keys()) {
      if (map.size <= MAX_ENTRIES) break;
      map.delete(key);
    }
  }

  private waiting(map: Map<string, Bucket>, key: string, allowance: number, now: number): boolean {
    const bucket = map.get(key);
    if (!bucket) return false;
    if (now - bucket.last >= this.settings.windowMs) {
      map.delete(key);
      return false;
    }
    if (bucket.count < allowance) return false;
    const over = bucket.count - allowance;
    const delay = Math.min(this.settings.baseDelayMs * 2 ** Math.min(over, 30), this.settings.maxDelayMs);
    return now - bucket.last < delay;
  }

  private add(map: Map<string, Bucket>, key: string, now: number): void {
    const bucket = map.get(key);
    // Re-insert so insertion order is last-touched order for eviction.
    map.delete(key);
    if (!bucket || now - bucket.last >= this.settings.windowMs) {
      map.set(key, { count: 1, last: now });
    } else {
      map.set(key, { count: bucket.count + 1, last: now });
    }
    this.bound(map, (entry) => now - entry.last >= this.settings.windowMs);
  }

  /** Entries held, for tests. */
  size(): { pairs: number; addresses: number; usernames: number; knownGood: number } {
    return {
      pairs: this.pairs.size,
      addresses: this.addresses.size,
      usernames: this.usernames.size,
      knownGood: this.knownGood.size,
    };
  }
}

function pairKey(username: string, address: string): string {
  return `${username}\u0000${address}`;
}

/** Stored form of a known-good pair: no username or address in the clear. */
export function knownGoodKey(username: string, address: string): string {
  return createHash("sha256").update(`known-good\u0000${pairKey(username, address)}`).digest("hex");
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export const SIGN_IN_WAIT =
  "Too many sign-in attempts. Wait a few minutes and try again.";

export const SIGN_IN_BUSY = "The server is busy. Wait a moment and try again.";
