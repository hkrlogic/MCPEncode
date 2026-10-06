/** Library list/create/delete, access list, and add-item under a library. */
import type express from "express";
import { accessFromLibraryRole, can, type Access, type LibraryRole } from "../../auth/rbac.ts";
import {
  addDraftItem,
  approveTableProposal,
  countLibraryAccess,
  countLibraryItems,
  createLibrary,
  deleteLibrary,
  getLibrary,
  getLibraryAccess,
  rejectTableProposal,
  grantLibraryAccess,
  listLibraryAccess,
  listItems,
  publishItems,
  revokeLibraryAccess,
  setLibraryWriteMode,
  writeAudit,
  type LibraryAccessRow,
  type LibraryRow,
} from "../../db/queries.ts";
import { libraryInputSchema } from "../../items/schema.ts";
import {
  formString,
  formToItemWrite,
  libraryTemplateFromForm,
  libraryWriteModeFromForm,
  requireCsrf,
  sessionAccess,
} from "../helpers.ts";
import { libraryMcpUrl } from "../library-url.ts";
import { addItemPage, addLibraryPage, errorPage, librariesPage, libraryPage, loginPage } from "../pages.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";

type SessionUser = Access & { csrf: string };

/** Library sections. Unknown values fall back to the published item list. */
function libraryTab(value: unknown): "items" | "pending" | "archives" | "access" {
  if (value === "pending" || value === "archives" || value === "access") return value;
  return "items";
}

/** Fixed copy for ?table=. Query text is never echoed. */
function tableDecisionNotice(flag: unknown): string | undefined {
  if (flag === "approved") {
    return "Table approved. Reconnect this library’s MCP link so agents see the new columns.";
  }
  if (flag === "rejected") return "Table proposal rejected. The library is unchanged.";
  if (flag === "blocked") {
    return "This library already has items, so the table was not approved. Reject the proposal, or approve a table on an empty library.";
  }
  if (flag === "missing") return "No table is waiting for approval.";
  if (flag === "unreadable") return "That table proposal could not be read, so it was not approved. Reject it and propose again.";
  return undefined;
}

/** Fixed copy for ?mode=. Query text is never echoed. */
function writeModeNotice(flag: unknown): string | undefined {
  if (flag === "reviewed") {
    return "This library is Reviewed. New and edited items stay Pending until you Publish.";
  }
  if (flag === "direct") {
    return "This library is Direct. Saves are live immediately for readers and agents.";
  }
  if (flag === "invalid") return "Choose Reviewed or Direct.";
  return undefined;
}

async function publisherShell(db: AppRouteContext["db"], access: SessionUser) {
  const shell = await loadAppShell(db, access);
  return {
    shellLibraries: shell.libraries,
    shellOrphans: shell.orphans,
  };
}

function listLibraryItems(
  db: AppRouteContext["db"],
  library: LibraryRow,
  query: { q?: string; limit?: number },
  publishedOnly: boolean,
) {
  return listItems(
    db,
    { library_id: library.id, q: query.q, limit: query.limit ?? 200 },
    { publishedOnly },
    { includeDetails: library.schema.starter === "table" },
  );
}

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
    const shell = await loadAppShell(db, access);
    res.send(
      librariesPage({
        access,
        csrf: access.csrf,
        libraries: shell.libraries,
        orphans: shell.orphans,
      }),
    );
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
    const writeMode = libraryWriteModeFromForm(formString(req.body, "write_mode"));
    const parsed = libraryInputSchema.safeParse({ name: formString(req.body, "name") });
    if (!parsed.success || !writeMode) {
      const shell = await loadAppShell(db, access);
      res.status(400).send(
        addLibraryPage({
          access,
          csrf: access.csrf,
          libraries: shell.libraries,
          orphans: shell.orphans,
          name: formString(req.body, "name").slice(0, 200),
          error: !writeMode
            ? "Choose Reviewed or Direct for how writes go live."
            : (parsed.error?.issues[0]?.message ?? "Invalid library"),
        }),
      );
      return;
    }
    const row = await createLibrary(db, parsed.data.name, access.sub, template, undefined, writeMode);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.create_library",
      success: true,
      detail: `${row.id}:${row.writeMode}`,
    });
    res.redirect(`/libraries/${row.id}`);
  });

  app.post("/libraries/:id/write-mode", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can change how writes go live."));
      return;
    }
    const writeMode = libraryWriteModeFromForm(formString(req.body, "write_mode"));
    if (!writeMode) {
      res.redirect(`/libraries/${ctxLib.library.id}?mode=invalid`);
      return;
    }
    const row = await setLibraryWriteMode(db, ctxLib.library.id, writeMode, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.set_write_mode",
      success: Boolean(row),
      detail: `${ctxLib.library.id}:${writeMode}`,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?mode=${writeMode}`);
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

  app.get("/libraries/new", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "records.write")) {
      res.status(403).send(errorPage("You cannot add libraries with this account."));
      return;
    }
    const shell = await loadAppShell(db, access);
    res.send(
      addLibraryPage({
        access,
        csrf: access.csrf,
        libraries: shell.libraries,
        orphans: shell.orphans,
      }),
    );
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
    const shell = await publisherShell(db, access);
    if ("orphan" in ctxLib) {
      res.send(
        libraryPage({
          access,
          csrf: access.csrf,
          library: ctxLib.library,
          items: [],
          mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
          orphan: true,
          ...shell,
        }),
      );
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const tab = libraryTab(req.query.tab);
    const publishedCount =
      typeof req.query.published === "string" ? req.query.published : undefined;
    const notice = tableDecisionNotice(req.query.table) ?? writeModeNotice(req.query.mode);
    const waiting =
      ctxLib.library.tableProposal != null || ctxLib.library.tableProposalUnreadable;
    const itemCount =
      can(ctxLib.libraryAccess, "records.write") && waiting
        ? await countLibraryItems(db, ctxLib.library.id)
        : 0;
    const items = await listLibraryItems(
      db,
      ctxLib.library,
      { q, limit: 200 },
      ctxLib.libraryAccess.libraryRole === "reader",
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
        tab,
        mcpUrl: libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id),
        accessList,
        viewerSub: access.sub,
        publishedCount,
        notice,
        itemCount,
        ...shell,
      }),
    );
  });

  app.post("/libraries/:id/items/publish", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can publish items."));
      return;
    }
    const raw = (req.body as { item_id?: string | string[] } | undefined)?.item_id;
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const published = await publishItems(db, ctxLib.library.id, ids, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.publish_bulk",
      success: published.length > 0,
      detail: `${ctxLib.library.id}:${published.length}`,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?published=${published.length}`);
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
      res.redirect(`/libraries/${ctxLib.library.id}?tab=access`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not grant access";
      const items = await listLibraryItems(db, ctxLib.library, { limit: 50 }, false);
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      const shell = await publisherShell(db, access);
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
          tab: "access",
          ...shell,
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
      res.redirect(`/libraries/${ctxLib.library.id}?tab=access`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not revoke access";
      const items = await listLibraryItems(db, ctxLib.library, { limit: 50 }, false);
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      const shell = await publisherShell(db, access);
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
          tab: "access",
          ...shell,
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
      const items = await listLibraryItems(db, ctxLib.library, { limit: 50 }, false);
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: false,
        detail: ctxLib.library.id,
      });
      const shell = await publisherShell(db, access);
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
          ...shell,
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
    const shell = await publisherShell(db, access);
    res.send(
      addItemPage({
        access: ctxLib.libraryAccess,
        csrf: access.csrf,
        library: ctxLib.library,
        shell: {
          libraries: shell.shellLibraries,
          orphans: shell.shellOrphans,
          activeLibraryId: ctxLib.library.id,
          csrf: access.csrf,
          canAddLibrary: can(access, "records.write"),
        },
      }),
    );
  });

  app.post("/libraries/:id/table/approve", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can approve a table."));
      return;
    }
    const result = await approveTableProposal(db, ctxLib.library.id, access.sub);
    const flag =
      result.ok ? "approved" : result.reason === "has_items" ? "blocked" : result.reason === "unreadable" ? "unreadable" : "missing";
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.approve_table",
      success: result.ok,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?table=${flag}`);
  });

  app.post("/libraries/:id/table/reject", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can reject a table."));
      return;
    }
    const removed = await rejectTableProposal(db, ctxLib.library.id, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.reject_table",
      success: removed,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?table=${removed ? "rejected" : "missing"}`);
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
    const result = await addDraftItem(
      db,
      ctxLib.library.id,
      formToItemWrite(req.body, ctxLib.library.schema),
      access.sub,
    );
    if (!result.ok) {
      const shell = await publisherShell(db, access);
      const library = (await getLibrary(db, ctxLib.library.id)) ?? ctxLib.library;
      res.status(400).send(
        addItemPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library,
          error: result.message,
          shell: {
            libraries: shell.shellLibraries,
            orphans: shell.shellOrphans,
            activeLibraryId: ctxLib.library.id,
            csrf: access.csrf,
            canAddLibrary: can(access, "records.write"),
          },
        }),
      );
      return;
    }
    await writeAudit(db, { actorSub: access.sub, tool: "ui.create", success: true, detail: result.item.id });
    const notice = result.item.status === "published" ? "created_live" : "created";
    res.redirect(`/items/${result.item.id}?notice=${notice}`);
  });
}
