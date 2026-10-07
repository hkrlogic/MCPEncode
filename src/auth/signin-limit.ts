/**
 * Temporary sign-in throttle for the built-in accounts.
 * A run of misses on one username, or one address, has to wait.
 * The wait ends on its own. The account is not locked, and a restart is not the unlock.
 * Counts live in this process only.
 */

const USERNAME_LIMIT = 5;
const ADDRESS_LIMIT = 20;
const WINDOW_MS = 15 * 60 * 1000;

type Bucket = { failures: number; windowStart: number };

export class SignInLimit {
  private readonly byUsername = new Map<string, Bucket>();
  private readonly byAddress = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = WINDOW_MS,
    private readonly usernameLimit: number = USERNAME_LIMIT,
    private readonly addressLimit: number = ADDRESS_LIMIT,
  ) {}

  /** True when this username or address must wait. Does not record a new miss. */
  blocked(username: string, address: string): boolean {
    return (
      this.over(this.byUsername, username, this.usernameLimit) ||
      this.over(this.byAddress, address, this.addressLimit)
    );
  }

  recordFailure(username: string, address: string): void {
    this.add(this.byUsername, username);
    this.add(this.byAddress, address);
  }

  /** A successful sign-in clears the misses for that username and that address. */
  recordSuccess(username: string, address: string): void {
    this.byUsername.delete(username);
    this.byAddress.delete(address);
  }

  private over(map: Map<string, Bucket>, key: string, limit: number): boolean {
    const bucket = map.get(key);
    if (!bucket) return false;
    if (this.now() - bucket.windowStart >= this.windowMs) {
      map.delete(key);
      return false;
    }
    return bucket.failures >= limit;
  }

  private add(map: Map<string, Bucket>, key: string): void {
    if (map.size > 1000) this.dropExpired(map);
    const current = map.get(key);
    const now = this.now();
    if (!current || now - current.windowStart >= this.windowMs) {
      map.set(key, { failures: 1, windowStart: now });
      return;
    }
    current.failures += 1;
  }

  private dropExpired(map: Map<string, Bucket>): void {
    const now = this.now();
    for (const [key, bucket] of map) {
      if (now - bucket.windowStart >= this.windowMs) map.delete(key);
    }
  }
}

export const SIGN_IN_WAIT =
  "Too many sign-in attempts. Wait a few minutes and try again.";
