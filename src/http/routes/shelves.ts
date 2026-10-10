/** Shelf create, rename, remove, and bonded search. No item edits. */
import type express from "express";
import { can, isSa } from "../../auth/rbac.ts";
import {
  createShelf,
  deleteShelf,
  getShelf,
  listShelfLibraries,
  renameShelf,
  searchShelf,
  writeAudit,
} from "../../db/queries.ts";
import { formString, requireCsrf, sessionAccess } from "../helpers.ts";
import { addShelfPage, shelfPage } from "../pages/shelves.ts";
import { errorPage } from "../pages.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";

export function registerShelfRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  app.get("/shelves/new", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "libraries.create")) {
      res.status(403).send(errorPage("You cannot add a shelf with this account."));
      return;
    }
    const shell = await loadAppShell(db, access);
    res.send(addShelfPage({ access, csrf: access.csrf, shell }));
  });

  app.post("/shelves", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "libraries.create")) {
      res.status(403).send(errorPage("You cannot add a shelf with this account."));
      return;
    }
    const created = await createShelf(db, formString(req.body, "name"), access.sub);
    if (!created.ok) {
      const shell = await loadAppShell(db, access);
      res.status(400).send(
        addShelfPage({
          access,
          csrf: access.csrf,
          shell,
          name: formString(req.body, "name").slice(0, 200),
          error: created.message,
        }),
      );
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.create_shelf",
      success: true,
      detail: created.shelf.id,
    });
    res.redirect(`/shelves/${created.shelf.id}`);
  });

  app.get("/shelves/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const shelf = await getShelf(db, req.params.id);
    if (!shelf) {
      res.status(404).send(errorPage("Shelf not found."));
      return;
    }
    const shell = await loadAppShell(db, access);
    const onShelf = await listShelfLibraries(db, shelf.id);
    const visibleIds = new Set(shell.libraries.map((row) => row.id));
    const libraries = isSa(access) ? onShelf : onShelf.filter((row) => visibleIds.has(row.id));
    if (!isSa(access) && libraries.length === 0) {
      res.status(403).send(errorPage("You do not have access to a library on this shelf."));
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const hits = q.trim()
      ? await searchShelf(db, shelf.id, q, { subject: access.sub, sa: isSa(access) })
      : undefined;
    if (q.trim()) {
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.search_shelf",
        success: true,
        detail: `${shelf.id}:${hits?.length ?? 0}`,
      });
    }
    const notice =
      req.query.renamed === "1"
        ? "Shelf renamed."
        : req.query.renamed === "invalid"
          ? "Enter a shelf name of 1–200 characters."
          : undefined;
    res.send(
      shelfPage({
        access,
        csrf: access.csrf,
        shell,
        shelf,
        libraries,
        q,
        hits,
        notice,
      }),
    );
  });

  app.post("/shelves/:id/rename", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "libraries.create")) {
      res.status(403).send(errorPage("You cannot rename a shelf with this account."));
      return;
    }
    const renamed = await renameShelf(db, req.params.id, formString(req.body, "name"), access.sub);
    if (!renamed.ok) {
      const flag = renamed.message === "Shelf not found." ? "" : "invalid";
      if (!flag) {
        res.status(404).send(errorPage("Shelf not found."));
        return;
      }
      res.redirect(`/shelves/${req.params.id}?renamed=invalid`);
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.rename_shelf",
      success: true,
      detail: renamed.shelf.id,
    });
    res.redirect(`/shelves/${renamed.shelf.id}?renamed=1`);
  });

  app.post("/shelves/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "libraries.create")) {
      res.status(403).send(errorPage("You cannot remove a shelf with this account."));
      return;
    }
    const removed = await deleteShelf(db, req.params.id);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.delete_shelf",
      success: removed,
      detail: req.params.id,
    });
    if (!removed) {
      res.status(404).send(errorPage("Shelf not found."));
      return;
    }
    res.redirect("/");
  });
}
