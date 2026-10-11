/**
 * Startup retry for Postgres. In Compose or on a platform the app can start
 * before the database accepts connections, so connection-level failures are
 * retried with a capped exponential backoff until a deadline. Anything else
 * (wrong password, missing database, bad config) fails on the first attempt.
 */

type ErrorLike = { code?: string; message?: string };

/** Network and "not accepting connections yet" codes from Node, DNS and Postgres. */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  // cannot_connect_now: "the database system is starting up" / "shutting down"
  "57P03",
]);

/** node-postgres reports its own connect timeouts and dropped handshakes by message only. */
const RETRYABLE_MESSAGES =
  /timeout exceeded when trying to connect|connection terminated due to connection timeout|connection terminated unexpectedly|the database system is (starting up|shutting down)/i;

/** True for errors that mean "Postgres is not reachable yet", not "Postgres said no". */
export function isRetryableConnectionError(error: unknown): boolean {
  const err = (error ?? {}) as ErrorLike;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  return RETRYABLE_MESSAGES.test(err.message ?? "");
}

/** Short reason for the retry log line: the error code, never the connection settings. */
export function connectionErrorReason(error: unknown): string {
  const err = (error ?? {}) as ErrorLike;
  if (err.code) return err.code;
  if (/timeout/i.test(err.message ?? "")) return "timeout";
  return "connection error";
}

export type RetryOptions = {
  /** Total time to keep trying, in milliseconds. 0 tries once. */
  timeoutMs: number;
  /** First wait between attempts. Doubles each time up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Run attempt() until it resolves, a non-retryable error is thrown, or the
 * deadline passes. With a window, an attempt still running at the deadline
 * counts as a timeout. On giving up the last connection error is rethrown as
 * is, so callers keep their existing error messages.
 */
export async function retryConnection<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const maxDelay = options.maxDelayMs ?? 5_000;
  let delay = options.initialDelayMs ?? 500;
  const deadline = now() + Math.max(0, options.timeoutMs);
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await withinDeadline(attempt(), deadline - now(), options.timeoutMs > 0);
    } catch (error) {
      const remaining = deadline - now();
      if (!isRetryableConnectionError(error) || remaining <= 0) throw error;
      const wait = Math.min(delay, maxDelay, remaining);
      options.onRetry?.({ attempt: attemptNumber, delayMs: wait, error });
      await sleep(wait);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/**
 * Stop waiting for an attempt when the window closes (a DNS lookup for a stopped
 * container can hang for seconds). The abandoned attempt settles on its own.
 */
async function withinDeadline<T>(attempt: Promise<T>, remainingMs: number, bounded: boolean): Promise<T> {
  if (!bounded) return attempt;
  attempt.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("Connection attempt timed out"), { code: "ETIMEDOUT" })),
      Math.max(0, remainingMs),
    );
  });
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    clearTimeout(timer);
  }
}
