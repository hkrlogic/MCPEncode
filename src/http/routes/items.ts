/** Item view/edit/update, publish gate, delete, files, and /notes redirects. */
import type express from "express";
import type { Request, Response } from "express";
import { accessForLibrary, can, type Access } from "../../auth/rbac.ts";
import {
  archiveItem,
  deleteItem,
  getLibrary,
  getLibraryAccess,
  addItemFile,
  getItemFile,
  listItemFiles,
  removeItemFile,
  getItem,
  publishItem,
  cancelPublishItem,
  restoreItem,
  revertToPublished,
  unpublishItem,
  updateItem,
  ItemConflictError,
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
import { formAliases, parseLibraryItem, requireCsrf, sessionAccess, tokensMatch } from "../helpers.ts";
import { editPage, errorPage, itemPage } from "../pages.ts";
import { readItemUpload } from "../upload.ts";
import type { AppRouteContext } from "./context.ts";

function downloadName(name: string): string {
  const ascii = name.replace(/[^\w.\- ()[\]]+/g, "_").replace(/"/g, "") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

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

/** Shown when the edit form was based on an older save. */
export const UI_CONFLICT_MESSAGE =
  "Someone saved this item after you opened it, so your edit was not saved. The form now shows the latest version. Reapply your change and save again.";

/** expected_revision from the edit form; absent or malformed means no check (old forms). */
function formRevision(body: unknown): number | undefined {
  const raw = (body as Record<string, unknown> | undefined)?.expected_revision;
  if (typeof raw !== "string" || !/^\d{1,16}$/.test(raw)) return undefined;
  return Number(raw);
}

export function registerItemRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  /** Shared gate for open item and Markdown export. */
  async function loadVisibleItem(req: Request, access: SessionUser) {
    const item = await getItem(db, String(req.params.id), { publishedOnly: false }).catch(() => undefined);
    if (!item) return { error: { status: 404 as const, message: "Item not found." } };
    const libraryAccess = await itemLibraryAccess(db, item.library_id, access);
    if (!libraryAccess) {
      return { error: { status: 403 as const, message: "You do not have access to this library." } };
    }
    // Readers see what is live: the published copy while an edit is Pending.
    const visible =
      libraryAccess.libraryRole === "reader"
        ? await getItem(db, item.id, { publishedOnly: true, libraryId: item.library_id })
        : item;
    if (!visible) {
      return { error: { status: 404 as const, message: "Item not found." } };
    }
    const library = await getLibrary(db, item.library_id);
    if (!library) return { error: { status: 404 as const, message: "Library not found." } };
    return { item: visible, library, libraryAccess };
  }

  app.get("/items/:id/export.md", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    try {
      const loaded = await loadVisibleItem(req, access);
      if (loaded.error) {
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
    if (loaded.error) {
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
    const files = await listItemFiles(db, item.id);
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
        files,
        shell,
        notice,
      }),
    );
  });

  app.get("/items/:id/files/:fileId", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const loaded = await loadVisibleItem(req, access);
    if (loaded.error) {
      res.status(loaded.error.status).send(errorPage(loaded.error.message));
      return;
    }
    const file = await getItemFile(db, loaded.item.id, req.params.fileId);
    if (!file) {
      res.status(404).send(errorPage("File not found."));
      return;
    }
    // Serve the sniffed type only, as a download, so a file cannot run as a page.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", downloadName(file.name));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Length", String(file.bytes.length));
    res.send(file.bytes);
  });

  app.post("/items/:id/files", async (req, res) => {
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
      res.status(403).send(errorPage("You cannot add files with this account."));
      return;
    }
    let upload;
    try {
      upload = await readItemUpload(req, (token) => tokensMatch(token, access.csrf));
    } catch (error) {
      console.error("item file upload failed", error);
      res.redirect(`/items/${encodeURIComponent(item.id)}?notice=file_type`);
      return;
    }
    if ((!upload.ok && upload.code === "csrf") || !tokensMatch(upload.csrf, access.csrf)) {
      // The rest of a forged upload is not read; close instead of draining it.
      res.setHeader("Connection", "close");
      res.status(403).send(errorPage("You cannot add files with this account."));
      return;
    }
    if (!upload.ok) {
      const notice = upload.code === "too_big" ? "file_too_big" : upload.code === "missing" ? "file_missing" : "file_type";
      res.redirect(`/items/${encodeURIComponent(item.id)}?notice=${notice}`);
      return;
    }
    const saved = await addItemFile(
      db,
      item.id,
      { filename: upload.filename, bytes: upload.bytes },
      access.sub,
    );
    const notice = !saved.ok
      ? saved.code === "too_many"
        ? "file_too_many"
        : saved.code === "too_big"
          ? "file_too_big"
          : saved.code === "empty"
            ? "file_empty"
            : saved.code === "not_found"
              ? "file_missing"
              : "file_type"
      : saved.pending
        ? "file_pending"
        : "file_added";
    res.redirect(`/items/${encodeURIComponent(item.id)}?notice=${notice}`);
  });

  app.post("/items/:id/files/:fileId/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot remove files with this account."));
      return;
    }
    const item = await getItem(db, req.params.id, { publishedOnly: false });
    if (!item) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const libraryAccess = await itemLibraryAccess(db, item.library_id, access);
    if (!libraryAccess || !can(libraryAccess, "records.write")) {
      res.status(403).send(errorPage("You cannot remove files with this account."));
      return;
    }
    const removed = await removeItemFile(db, item.id, req.params.fileId, access.sub);
    const notice = !removed.ok ? "file_missing" : removed.pending ? "file_removed_pending" : "file_removed";
    res.redirect(`/items/${encodeURIComponent(item.id)}?notice=${notice}`);
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
      const aliases = formAliases(req.body);
      const input = aliases === undefined ? parsed.data : { ...parsed.data, aliases };
      row = await updateItem(db, req.params.id, input, access.sub, {
        expectedRevision: formRevision(req.body),
      });
    } catch (error) {
      const shell = await itemShell(db, access, library.id);
      if (error instanceof ItemConflictError) {
        // Show the latest saved copy so the person can reapply their change.
        const latest = (await getItem(db, req.params.id, { publishedOnly: false })) ?? item;
        res.status(409).send(
          editPage({
            access: libraryAccess,
            csrf: access.csrf,
            item: latest,
            library,
            error: UI_CONFLICT_MESSAGE,
            shell,
          }),
        );
        return;
      }
      const message = error instanceof Error ? error.message : "Could not save item.";
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
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.update",
      success: true,
      libraryId: row.library_id,
      detail: row.id,
    });
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
      libraryId: row.library_id,
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
  app.post("/items/:id/cancel", async (req, res) => {
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
    const result = await cancelPublishItem(db, id, access.sub);
    if (!result.ok) {
      res.status(400).send(
        errorPage(
          result.reason === "unreadable"
            ? "The last published copy could not be read. The publish request was not canceled."
            : "Only Pending items can have a publish request canceled.",
        ),
      );
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.cancel_publish",
      success: true,
      libraryId: result.item.library_id,
      detail: `${result.item.id}:${result.kind}`,
    });
    const notice = result.kind === "archived" ? "canceled_new" : "canceled";
    res.redirect(`/items/${result.item.id}?notice=${notice}`);
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

  /** Replace working fields with published_snapshot. Not the same as Restore (un-archive). */
  app.post("/items/:id/revert-published", async (req, res) => {
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
    const result = await revertToPublished(db, id, access.sub);
    if (!result.ok) {
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.revert_to_published",
        success: false,
        detail: `${id}:${result.reason}`,
      });
      const message =
        result.reason === "not_found"
          ? "Item not found."
          : result.reason === "archived"
            ? "Archived items must be restored to Pending before you can revert to published."
            : result.reason === "no_snapshot"
              ? "This item has never been published, so there is nothing to revert to."
              : result.reason === "unreadable"
                ? "The last published snapshot could not be read. Revert was not applied."
                : "No changes since last published — nothing to revert.";
      res.status(result.reason === "not_found" ? 404 : 400).send(errorPage(message));
      return;
    }
    const publishedAt = result.item.published_snapshot?.published_at ?? 0;
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.revert_to_published",
      success: true,
      libraryId: result.item.library_id,
      detail: `${result.item.id} kind=${result.kind} published_at=${publishedAt}`,
    });
    const notice = result.kind === "previous" ? "reverted_previous" : "reverted";
    res.redirect(`/items/${result.item.id}?notice=${notice}`);
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
      libraryId,
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
