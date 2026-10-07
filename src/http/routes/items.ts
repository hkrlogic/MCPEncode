/** Item view/edit/update, publish gate, delete, and /notes redirects. */
import type express from "express";
import type { Request, Response } from "express";
import { accessForLibrary, can, type Access } from "../../auth/rbac.ts";
import {
  archiveItem,
  deleteItem,
  getLibrary,
  getLibraryAccess,
  getItem,
  publishItem,
  restoreItem,
  unpublishItem,
  updateItem,
  writeAudit,
} from "../../db/queries.ts";
import type { AppShell } from "../pages/layout.ts";
import { loadAppShell } from "../shell.ts";
import {
  policyBody,
  policyControl,
  procedureBody,
  procedureControl,
} from "../../items/templates.ts";
import { itemToMarkdown, markdownExportFilename } from "../../items/export-markdown.ts";
import { parseTableValues, tableControl, tableParts } from "../../items/table-proposal.ts";
import { renderMarkdown } from "../../markdown/render.ts";
import { parseLibraryItem, requireCsrf, sessionAccess } from "../helpers.ts";
import { editPage, errorPage, itemPage } from "../pages.ts";
import type { AppRouteContext } from "./context.ts";

type SessionUser = Access & { csrf: string };

async function itemLibraryAccess(
  db: AppRouteContext["db"],
  libraryId: string,
  access: SessionUser,
): Promise<SessionUser | undefined> {
  const membership = await getLibraryAccess(db, libraryId, access.sub);
  const libraryAccess = accessForLibrary({
    sub: access.sub,
    clientId: access.clientId,
    idpRole: access.role,
    libraryRole: membership?.role,
  });
  if (!libraryAccess) return undefined;
  return { ...libraryAccess, csrf: access.csrf };
}

async function itemShell(
  db: AppRouteContext["db"],
  access: SessionUser,
  libraryId: string,
): Promise<AppShell> {
  const shell = await loadAppShell(db, access);
  return { ...shell, activeLibraryId: libraryId };
}

export function registerItemRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  /** Shared gate for open item and Markdown export. */
  async function loadVisibleItem(req: Request, access: SessionUser) {
    const item = await getItem(db, req.params.id, { publishedOnly: false }).catch(() => undefined);
    if (!item) return { error: { status: 404 as const, message: "Item not found." } };
    const libraryAccess = await itemLibraryAccess(db, item.library_id, access);
    if (!libraryAccess) {
      return { error: { status: 403 as const, message: "You do not have access to this library." } };
    }
    if (libraryAccess.libraryRole === "reader" && item.status !== "published") {
      return { error: { status: 404 as const, message: "Item not found." } };
    }
    const library = await getLibrary(db, item.library_id);
    if (!library) return { error: { status: 404 as const, message: "Library not found." } };
    return { item, library, libraryAccess };
  }

  app.get("/items/:id/export.md", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    try {
      const loaded = await loadVisibleItem(req, access);
      if ("error" in loaded) {
        res.status(loaded.error.status).send(errorPage(loaded.error.message));
        return;
      }
      const markdown = itemToMarkdown(loaded.item, loaded.library);
      const filename = markdownExportFilename(loaded.item.name);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(markdown);
    } catch (error) {
      console.error("export.md failed", error);
      res.status(500).send(errorPage("Could not export this item as Markdown."));
    }
  });

  app.get("/items/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const notice = typeof req.query.notice === "string" ? req.query.notice : undefined;
    const loaded = await loadVisibleItem(req, access);
    if ("error" in loaded) {
      res.status(loaded.error.status).send(errorPage(loaded.error.message));
      return;
    }
    const { item, library, libraryAccess } = loaded;
    const tableValues =
      library.schema.starter === "table" ? parseTableValues(item.details) : undefined;
    const structured = tableValues
      ? { control: tableControl(library.schema.fields, tableValues), parts: tableParts(library.schema.fields, tableValues) }
      : item.policy
      ? { control: policyControl(item.policy), parts: policyBody(item.policy) }
      : item.procedure
        ? { control: procedureControl(item.procedure), parts: procedureBody(item.procedure) }
        : undefined;
    const html = structured ? "" : await renderMarkdown(item.body);
    const control = structured?.control;
    const sections = structured
      ? await Promise.all(
          structured.parts.map(async (part) => ({
            heading: part.label,
            html: await renderMarkdown(part.text),
          })),
        )
      : undefined;
    const shell = await itemShell(db, access, library.id);
    res.send(
      itemPage({
        access: libraryAccess,
        csrf: access.csrf,
        item,
        library,
        html,
        control,
        sections,
        shell,
        notice,
      }),
    );
  });

  app.get("/items/:id/edit", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const item = await getItem(db, req.params.id, { publishedOnly: false });
    if (!item) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const libraryAccess = await itemLibraryAccess(db, item.library_id, access);
    if (!libraryAccess || !can(libraryAccess, "records.write")) {
      res.status(403).send(errorPage("Readers cannot edit items."));
      return;
    }
    const library = await getLibrary(db, item.library_id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const shell = await itemShell(db, access, library.id);
    res.send(editPage({ access: libraryAccess, csrf: access.csrf, item, library, shell }));
  });

  app.post("/items/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot edit items with this account."));
      return;
    }
    const item = await getItem(db, req.params.id, { publishedOnly: false });
    if (!item) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const libraryAccess = await itemLibraryAccess(db, item.library_id, access);
    if (!libraryAccess || !can(libraryAccess, "records.write")) {
      res.status(403).send(errorPage("You cannot edit items with this account."));
      return;
    }
    const library = await getLibrary(db, item.library_id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const parsed = parseLibraryItem(req.body, library);
    if (!parsed.success) {
      const shell = await itemShell(db, access, library.id);
      res.status(400).send(
        editPage({
          access: libraryAccess,
          csrf: access.csrf,
          item,
          library,
          error: parsed.error.issues[0]?.message ?? "Invalid item",
          shell,
        }),
      );
      return;
    }
    const wasPublished = item.status === "published";
    let row;
    try {
      row = await updateItem(db, req.params.id, parsed.data, access.sub);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save item.";
      const shell = await itemShell(db, access, library.id);
      res.status(400).send(
        editPage({
          access: libraryAccess,
          csrf: access.csrf,
          item,
          library,
          error: message,
          shell,
        }),
      );
      return;
    }
    if (!row) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    await writeAudit(db, { actorSub: access.sub, tool: "ui.update", success: true, detail: row.id });
    const notice =
      library.writeMode === "direct"
        ? "saved_live"
        : wasPublished
          ? "pending"
          : "";
    res.redirect(`/items/${row.id}${notice ? `?notice=${notice}` : ""}`);
  });

  async function gateAction(
    req: Request,
    res: Response,
    action: "publish" | "unpublish" | "archive" | "restore",
  ): Promise<void> {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot change publish status with this account."));
      return;
    }
    const id = typeof req.params.id === "string" ? req.params.id : req.params.id?.[0];
    if (!id) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const existing = await getItem(db, id, { publishedOnly: false });
    if (!existing) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const libraryAccess = await itemLibraryAccess(db, existing.library_id, access);
    if (!libraryAccess || !can(libraryAccess, "records.write")) {
      res.status(403).send(errorPage("You cannot change publish status with this account."));
      return;
    }
    const runners = {
      publish: publishItem,
      unpublish: unpublishItem,
      archive: archiveItem,
      restore: restoreItem,
    } as const;
    const row = await runners[action](db, id, access.sub);
    if (!row) {
      res.status(400).send(
        errorPage(
          action === "publish"
            ? "Only Pending (draft) items can be published."
            : action === "unpublish"
              ? "Only published items can be unpublished."
              : action === "archive"
                ? "This item is already archived."
                : "Only archived items can be restored.",
        ),
      );
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: `ui.${action}`,
      success: true,
      detail: row.id,
    });
    const notice =
      action === "publish"
        ? "published"
        : action === "unpublish"
          ? "pending"
          : action === "archive"
            ? "archived"
            : "restored";
    res.redirect(`/items/${row.id}?notice=${notice}`);
  }

  app.post("/items/:id/publish", (req, res) => {
    void gateAction(req, res, "publish");
  });
  app.post("/items/:id/unpublish", (req, res) => {
    void gateAction(req, res, "unpublish");
  });
  app.post("/items/:id/archive", (req, res) => {
    void gateAction(req, res, "archive");
  });
  app.post("/items/:id/restore", (req, res) => {
    void gateAction(req, res, "restore");
  });

  app.post("/items/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot delete items with this account."));
      return;
    }
    const existing = await getItem(db, req.params.id, { publishedOnly: false });
    if (!existing) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const libraryAccess = await itemLibraryAccess(db, existing.library_id, access);
    if (!libraryAccess || !can(libraryAccess, "records.delete")) {
      res.status(403).send(errorPage("You cannot delete items with this account."));
      return;
    }
    const libraryId = existing.library_id;
    const removed = await deleteItem(db, req.params.id);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.delete",
      success: removed,
      detail: req.params.id,
    });
    res.redirect(libraryId ? `/libraries/${libraryId}` : "/");
  });

  app.get("/notes/:id/edit", (req, res) => {
    res.redirect(`/items/${req.params.id}/edit`);
  });
  app.get("/notes/:id", (req, res) => {
    res.redirect(`/items/${req.params.id}`);
  });
}
