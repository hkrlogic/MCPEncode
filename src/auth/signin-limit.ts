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
 * lock. Nothing is ever locked until an admin acts.
 *
 * An attempt is counted when it starts, before the password is hashed, so a
 * burst of parallel posts cannot all slip in under the limit. A successful
 * sign-in takes its own count back and clears that username's misses.
 * Counts live in this process only. Put a per-address limit at the proxy as
 * well (docs/deploy.md).
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
};

type Bucket = { count: number; last: number };

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

  constructor(options: SignInLimitOptions = {}) {
    this.now = options.now ?? Date.now;
    this.settings = { ...DEFAULTS, ...stripUndefined(options) };
  }

  /** True when this username or address must wait. Does not count anything. */
  blocked(username: string, address: string): boolean {
    const now = this.now();
    return (
      this.waiting(this.pairs, pairKey(username, address), this.settings.pairAllowance, now) ||
      this.waiting(this.addresses, address, this.settings.addressAllowance, now) ||
      this.waiting(this.usernames, username, this.settings.usernameAllowance, now)
    );
  }

  /**
   * Call before checking the password. Returns false (and counts nothing) when
   * the caller must wait; otherwise counts the attempt as a miss until
   * succeed() takes it back.
   */
  begin(username: string, address: string): boolean {
    if (this.blocked(username, address)) return false;
    const now = this.now();
    this.add(this.pairs, pairKey(username, address), now);
    this.add(this.addresses, address, now);
    this.add(this.usernames, username, now);
    return true;
  }

  /** The attempt begun for this username and address signed in. */
  succeed(username: string, address: string): void {
    this.pairs.delete(pairKey(username, address));
    this.usernames.delete(username);
    const bucket = this.addresses.get(address);
    if (bucket) {
      bucket.count -= 1;
      if (bucket.count <= 0) this.addresses.delete(address);
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
    if (map.size > 10_000) this.dropExpired(map, now);
    const bucket = map.get(key);
    if (!bucket || now - bucket.last >= this.settings.windowMs) {
      map.set(key, { count: 1, last: now });
      return;
    }
    bucket.count += 1;
    bucket.last = now;
  }

  private dropExpired(map: Map<string, Bucket>, now: number): void {
    for (const [key, bucket] of map) {
      if (now - bucket.last >= this.settings.windowMs) map.delete(key);
    }
  }
}

function pairKey(username: string, address: string): string {
  return `${username}\u0000${address}`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export const SIGN_IN_WAIT =
  "Too many sign-in attempts. Wait a few minutes and try again.";

export const SIGN_IN_BUSY = "The server is busy. Wait a moment and try again.";
