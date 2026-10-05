/**
 * The small set of calls the rest of the app needs.
 * Callers never see the Postgres driver, so the driver can change later
 * without a sweep through the HTTP and MCP code.
 */
export type Database = {
  /** Run one or more SQL statements that do not take parameters. */
  exec(sql: string): Promise<void>;
  all(sql: string, ...params: unknown[]): Promise<unknown[]>;
  get(sql: string, ...params: unknown[]): Promise<unknown>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  prepare(sql: string): Promise<{
    all(...params: unknown[]): Promise<unknown[]>;
    get(...params: unknown[]): Promise<unknown>;
    run(...params: unknown[]): Promise<void>;
  }>;
  /** Commit every statement, or roll them all back. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
