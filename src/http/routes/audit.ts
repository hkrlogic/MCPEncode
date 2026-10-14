/** Settings → Audit log. Site admin: every event. Publisher: their libraries. */
import type express from "express";
import { can } from "../../auth/rbac.ts";
import { listLibrariesForSubject, listAllLibrariesForSa } from "../../db/access.ts";
import { listAuditLog } from "../../db/audit.ts";
import { auditPage } from "../pages/audit.ts";
import { sessionAccess } from "../helpers.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";

const PAGE_SIZE = 50;

export function registerAuditRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  app.get("/audit", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const all = can(access, "accounts.manage");
    const libraries = all
      ? (await listAllLibrariesForSa(db)).map((row) => ({ id: row.id, name: row.name }))
      : (await listLibrariesForSubject(db, access.sub))
          .filter((row) => row.access_role === "publisher")
          .map((row) => ({ id: row.id, name: row.name }));
    const requested = typeof req.query.library === "string" ? req.query.library : "";
    // Only a library from the person's own list can be chosen; anything else is ignored.
    const libraryId = libraries.some((row) => row.id === requested) ? requested : undefined;
    const pageRaw = Number(typeof req.query.page === "string" ? req.query.page : "1");
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 10_000 ? pageRaw : 1;
    const scope = libraryId ? [libraryId] : all ? null : libraries.map((row) => row.id);
    const { rows, hasMore } = await listAuditLog(db, {
      libraryIds: scope,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    res.setHeader("Cache-Control", "no-store");
    res.send(
      auditPage({
        access,
        csrf: access.csrf,
        shell: await loadAppShell(db, access),
        rows,
        page,
        hasMore,
        libraries,
        libraryId,
        all,
      }),
    );
  });
}
