/** Liveness and database check for load balancers, Docker HEALTHCHECK and hosts. */
import type { Request, Response } from "express";
import type { Database } from "../db/types.ts";

/** Fail fast so a container health probe does not wait out the pool timeout. */
export const HEALTH_DB_TIMEOUT_MS = 3_000;

/**
 * GET /healthz. 200 when Postgres answers, 503 when it does not.
 * No auth, no Host check, and no detail about the failure: the error stays in the server log.
 */
export function healthHandler(db: Database, timeoutMs = HEALTH_DB_TIMEOUT_MS) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.set("Cache-Control", "no-store");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.get("SELECT 1 AS ok"),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("database check timed out")), timeoutMs);
        }),
      ]);
      res.status(200).json({ status: "ok", database: "ok" });
    } catch (error) {
      console.error("healthz: database check failed:", error instanceof Error ? error.message : error);
      res.status(503).json({ status: "unavailable", database: "unreachable" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
