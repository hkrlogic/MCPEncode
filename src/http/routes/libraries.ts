/** Library list/create/delete, access list, and add-item under a library. */
import type express from "express";
import { accessFromLibraryRole, can, type Access, type LibraryRole } from "../../auth/rbac.ts";
import {
  countLibraryAccess,
  createLibrary,
  createItem,
  deleteLibrary,
  getLibrary,
  getLibraryAccess,
  grantLibraryAccess,
  listLibrariesForSubject,
  listLibraryAccess,
  listOrphanLibraries,
  listItems,
  revokeLibraryAccess,
  writeAudit,
  type LibraryAccessRow,
  type LibraryRow,
} from "../../db/queries.ts";
import { libraryInputSchema } from "../../items/schema.ts";
import {
  formString,
  libraryTemplateFromForm,
  parseLibraryItem,
  requireCsrf,
  sessionAccess,
} from "../helpers.ts";
import { libraryMcpUrl } from "../library-url.ts";
import { addItemPage, errorPage, librariesPage, libraryPage, loginPage } from "../pages.ts";
import type { AppRouteContext } from "./context.ts";

type SessionUser = Access & { csrf: string };

async function libraryContext(
  db: AppRouteContext["db"],
  libraryId: string,
  access: SessionUser,
): Promise<
  | {
      library: LibraryRow;
      membership: LibraryAccessRow;
      libraryAccess: SessionUser;
    }
  | { library: LibraryRow; orphan: true }
  | undefined
> {
  const library = await getLibrary(db, libraryId);
  if (!library) return undefined;
  const membership = await getLibraryAccess(db, library.id, access.sub);
  if (membership) {
    return {
      library,
      membership,
      libraryAccess: {
        ...accessFromLibraryRole({
          sub: access.sub,
          clientId: access.clientId,
          libraryRole: membership.role,
        }),
        csrf: access.csrf,
      },
    };
  }
  const members = await countLibraryAccess(db, library.id);
  if (members === 0 && can(access, "records.write")) {
    return { library, orphan: true };
  }
  return undefined;
}

export function registerLibraryRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  app.get("/", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.send(loginPage());
      return;
    }
    const libraries = await listLibrariesForSubject(db, access.sub);
    const orphans =
      can(access, "records.write") ? await listOrphanLibraries(db) : [];
    res.send(librariesPage({ access, csrf: access.csrf, libraries, orphans }));
  });

  app.post("/libraries", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot add libraries with this account."));
      return;
    }
    const template = libraryTemplateFromForm(formString(req.body, "template"));
    const parsed = libraryInputSchema.safeParse({ name: formString(req.body, "name") });
    if (!parsed.success) {
      const libraries = await listLibrariesForSubject(db, access.sub);
      const orphans = await listOrphanLibraries(db);
      res.status(400).send(
        librariesPage({
          access,
          csrf: access.csrf,
          libraries,
          orphans,
          error: parsed.error.issues[0]?.message ?? "Invalid library",
        }),
      );
      return;
    }
    const row = await createLibrary(db, parsed.data.name, access.sub, template);
    await writeAudit(db, { actorSub: access.sub, tool: "ui.create_library", success: true, detail: row.id });
    res.redirect(`/libraries/${row.id}`);
  });

  app.post("/libraries/:id/claim", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot claim libraries with this account."));
      return;
    }
    const library = await getLibrary(db, req.params.id);
    if (!library) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    const members = await countLibraryAccess(db, library.id);
    if (members > 0) {
      res.status(403).send(errorPage("This library already has an access list."));
      return;
    }
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: access.sub,
      role: "publisher",
      grantedBy: access.sub,
    });
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.claim_library",
      success: true,
      detail: library.id,
    });
    res.redirect(`/libraries/${library.id}`);
  });

  app.get("/libraries/:id", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib) {
      res.status(403).send(errorPage("You do not have access to this library."));
      return;
    }
    if ("orphan" in ctxLib) {
      res.send(
        libraryPage({
          access,
          csrf: access.csrf,
          library: ctxLib.library,
          items: [],
          mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
          orphan: true,
        }),
      );
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const items = await listItems(
      db,
      { library_id: ctxLib.library.id, q, limit: 200 },
      { publishedOnly: ctxLib.libraryAccess.libraryRole === "reader" },
    );
    const accessList = can(ctxLib.libraryAccess, "records.write")
      ? await listLibraryAccess(db, ctxLib.library.id)
      : [];
    res.send(
      libraryPage({
        access: ctxLib.libraryAccess,
        csrf: access.csrf,
        library: ctxLib.library,
        items,
        q,
        mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
        accessList,
        viewerSub: access.sub,
      }),
    );
  });

  app.post("/libraries/:id/access", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("Invalid form token. Reload and try again."));
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "records.write")) {
      res.status(403).send(errorPage("Only publishers on this library can manage access."));
      return;
    }
    const subject = formString(req.body, "subject").trim();
    const roleRaw = formString(req.body, "role");
    const role: LibraryRole = roleRaw === "publisher" ? "publisher" : "reader";
    try {
      await grantLibraryAccess(db, {
        libraryId: ctxLib.library.id,
        subject,
        role,
        grantedBy: access.sub,
      });
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.grant_access",
        success: true,
        detail: `${ctxLib.library.id}:${subject}:${role}`,
      });
      res.redirect(`/libraries/${ctxLib.library.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not grant access";
      const items = await listItems(
        db,
        { library_id: ctxLib.library.id, limit: 50 },
        { publishedOnly: false },
      );
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      res.status(400).send(
        libraryPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          items,
          mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
          accessList,
          viewerSub: access.sub,
          error: message,
        }),
      );
    }
  });

  app.post("/libraries/:id/access/revoke", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("Invalid form token. Reload and try again."));
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "records.write")) {
      res.status(403).send(errorPage("Only publishers on this library can manage access."));
      return;
    }
    const subject = formString(req.body, "subject").trim();
    try {
      await revokeLibraryAccess(db, ctxLib.library.id, subject);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.revoke_access",
        success: true,
        detail: `${ctxLib.library.id}:${subject}`,
      });
      res.redirect(`/libraries/${ctxLib.library.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not revoke access";
      const items = await listItems(
        db,
        { library_id: ctxLib.library.id, limit: 50 },
        { publishedOnly: false },
      );
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      res.status(400).send(
        libraryPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          items,
          mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
          accessList,
          viewerSub: access.sub,
          error: message,
        }),
      );
    }
  });

  app.post("/libraries/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot delete libraries with this account."));
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "records.delete")) {
      res.status(403).send(errorPage("Only publishers on this library can delete it."));
      return;
    }
    try {
      const removed = await deleteLibrary(db, ctxLib.library.id);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: removed,
        detail: ctxLib.library.id,
      });
      res.redirect("/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete this library";
      const items = await listItems(
        db,
        { library_id: ctxLib.library.id, limit: 50 },
        { publishedOnly: false },
      );
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: false,
        detail: ctxLib.library.id,
      });
      res.status(400).send(
        libraryPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          items,
          mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
          accessList,
          viewerSub: access.sub,
          error: message,
        }),
      );
    }
  });

  app.get("/libraries/:id/items/new", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib) {
      res.status(403).send(errorPage("You do not have access to this library."));
      return;
    }
    if (!can(ctxLib.libraryAccess, "records.write")) {
      res.status(403).send(errorPage("Readers cannot add items."));
      return;
    }
    res.send(addItemPage({ access: ctxLib.libraryAccess, csrf: access.csrf, library: ctxLib.library }));
  });

  app.post("/libraries/:id/items", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot add items with this account."));
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "records.write")) {
      res.status(403).send(errorPage("You cannot add items with this account."));
      return;
    }
    const parsed = parseLibraryItem(req.body, ctxLib.library.template);
    if (!parsed.success) {
      res.status(400).send(
        addItemPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          error: parsed.error.issues[0]?.message ?? "Invalid item",
        }),
      );
      return;
    }
    const row = await createItem(db, parsed.data, access.sub, ctxLib.library.id);
    await writeAudit(db, { actorSub: access.sub, tool: "ui.create", success: true, detail: row.id });
    res.redirect(`/items/${row.id}?notice=created`);
  });
}
