/** Library list/create/delete, access list, and add-item under a library. */
import type express from "express";
import { accessForLibrary, can, isSa, type Access, type LibraryRole } from "../../auth/rbac.ts";
import { accountStore } from "../../db/accounts.ts";
import {
  addDraftItem,
  approveFieldProposal,
  approveTableProposal,
  copyLibraryTemplate,
  countLibraryAccess,
  countLibraryItems,
  createLibrary,
  deleteLibrary,
  getLibrary,
  getLibraryAccess,
  rejectFieldProposal,
  rejectTableProposal,
  grantLibraryAccess,
  listLibraryAccess,
  listItems,
  listShelves,
  setLibraryShelf,
  publishItems,
  cancelPublishItems,
  renameLibrary,
  revokeLibraryAccess,
  rotateLibraryConnectToken,
  issueLibraryReaderKey,
  clearLibraryReaderKey,
  setLibraryWriteMode,
  writeAudit,
  type LibraryAccessRow,
  type LibraryRow,
} from "../../db/queries.ts";
import { normalizeUsername } from "../../auth/passwords.ts";
import { READER_REVEAL_COOKIE, stashReaderKeyReveal, takeReaderKeyReveal } from "../../auth/reader-key.ts";
import { customSchemaFromRows } from "../../items/custom-schema.ts";
import { libraryInputSchema } from "../../items/schema.ts";
import { writeModeLabel } from "../pages/schema-choice.ts";
import {
  formString,
  formAliases,
  formToItemWrite,
  postedCustomFields,
  libraryTemplateFromForm,
  libraryWriteModeFromForm,
  requireCsrf,
  sessionAccess,
} from "../helpers.ts";
import { cookieHeader, readCookie } from "../cookies.ts";
import { libraryMcpUrl, maskedLibraryMcpUrl } from "../library-url.ts";
import { CONNECT_REVEAL_COOKIE, stashConnectReveal, takeConnectReveal } from "../../auth/connect-reveal.ts";
import { addItemPage, addLibraryPage, errorPage, librariesPage, libraryPage } from "../pages.ts";
import { loadAppShell } from "../shell.ts";
import { reviewQueue } from "../../db/freshness.ts";
import type { AppRouteContext } from "./context.ts";

type SessionUser = Access & { csrf: string };

/** Masked Connect link ("…a1b2"). The full link exists only in the one-time reveal. */
function libraryConnectUrl(config: AppRouteContext["config"], library: LibraryRow): string {
  return maskedLibraryMcpUrl(config.publicBaseUrl, library.id, library.connectTokenLast4);
}

/** Hold a new Connect token for the publisher's next page load. The cookie carries only a reveal id. */
function setConnectReveal(
  res: express.Response,
  config: AppRouteContext["config"],
  input: { libraryId: string; sub: string; token: string },
): void {
  const revealId = stashConnectReveal(input);
  res.append(
    "Set-Cookie",
    cookieHeader(CONNECT_REVEAL_COOKIE, revealId, {
      maxAge: 120,
      path: readerKeyCookiePath(input.libraryId),
      secure: config.publicBaseUrl.startsWith("https://"),
    }),
  );
}

/** Cookie path for the one-time Reader key reveal. Matches the library page only. */
function readerKeyCookiePath(libraryId: string): string {
  return `/libraries/${libraryId}`;
}

/** Built-in sign-in grants by username; external IdP still uses the subject field. */
async function resolveGrantSubject(
  db: AppRouteContext["db"],
  authMode: AppRouteContext["config"]["authMode"],
  body: unknown,
): Promise<string> {
  if (authMode === "embedded") {
    const username = normalizeUsername(formString(body, "username"));
    if (!username) throw new Error("Choose someone to grant access.");
    const account = await accountStore(db).findByUsername(username);
    if (!account) throw new Error("That person does not have an account.");
    if (account.disabled) throw new Error("That account is disabled. Enable it before granting access.");
    return account.id;
  }
  const subject = formString(body, "subject").trim();
  if (!subject) throw new Error("Subject is required");
  return subject;
}

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

/** Fixed copy for ?field=. Query text is never echoed. */
function fieldDecisionNotice(flag: unknown): string | undefined {
  if (flag === "approved") {
    return "Field approved. Reconnect this library’s MCP link so agents see the new field.";
  }
  if (flag === "rejected") return "Field proposal rejected. The library is unchanged.";
  if (flag === "missing") return "No field is waiting for approval.";
  if (flag === "unreadable") {
    return "That field proposal could not be read, so it was not approved. Reject it and propose again.";
  }
  if (flag === "conflict") {
    return "That field could not be approved because it clashes with an existing field. Reject it.";
  }
  if (flag === "at_cap") {
    return "That field could not be approved because this library already has 12 fields. Reject it.";
  }
  return undefined;
}

/** Fixed copy for ?mode=. Query text is never echoed. */
function writeModeNotice(flag: unknown): string | undefined {
  if (flag === "reviewed") {
    return `This library is ${writeModeLabel("reviewed")}. New and edited items stay Pending until you Publish.`;
  }
  if (flag === "direct") {
    return `This library is ${writeModeLabel("direct")}. Saves are live immediately for readers and agents.`;
  }
  if (flag === "invalid") return `Choose ${writeModeLabel("reviewed")} or ${writeModeLabel("direct")}.`;
  return undefined;
}

/** Fixed copy for ?reader-key=. Query text is never echoed. The secret is never put in the query. */
function readerKeyNotice(flag: unknown): string | undefined {
  if (flag === "removed") {
    return "Reader key removed. Shared agents using it can no longer read this library until you create a new one.";
  }
  return undefined;
}

/** Fixed copy for ?connect=. Query text is never echoed. */
function connectNotice(flag: unknown): string | undefined {
  if (flag === "rotated") {
    return "Connect link rotated. Old links stop working. Copy the new link from Connect now; it is shown only once. People on Access are unchanged.";
  }
  return undefined;
}

/** Fixed copy for ?shelf=. Query text is never echoed. */
function shelfMoveNotice(flag: unknown): string | undefined {
  if (flag === "1") return "Shelf updated. Published items are searched with that shelf.";
  if (flag === "invalid") return "That shelf could not be used. Choose a shelf from the list.";
  return undefined;
}

/** Fixed copy for ?renamed=. Query text is never echoed. */
function renameNotice(flag: unknown): string | undefined {
  if (flag === "1") return "Library renamed.";
  if (flag === "invalid") return "Enter a library name of 1–200 characters.";
  return undefined;
}

/** Fixed copy for ?canceled= and ?canceled_new=. Counts only; query text is never echoed. */
function cancelNotice(canceledRaw: unknown, archivedRaw: unknown): string | undefined {
  const canceled = typeof canceledRaw === "string" ? Number(canceledRaw) : NaN;
  const archived = typeof archivedRaw === "string" ? Number(archivedRaw) : 0;
  if (!Number.isInteger(canceled) || canceled < 1 || canceled > 500) return undefined;
  const archivedCount =
    Number.isInteger(archived) && archived >= 0 && archived <= canceled ? archived : 0;
  const head =
    canceled === 1 ? "1 publish request canceled." : `${canceled} publish requests canceled.`;
  if (archivedCount === 0) return `${head} They are back to the last published version.`;
  if (archivedCount === canceled) {
    return `${head} They were never published, so they are in Archives.`;
  }
  return `${head} New items are in Archives. The others are back to the last published version.`;
}

/** Fixed copy for ?copied= — only fixed flags, never echo names from the query. */
function copyNotice(flag: unknown): string | undefined {
  if (flag === "1") {
    return "Library template copied into a new empty library. You are its publisher. Add fields with propose_field (Approve in the publisher), or add items. Items and Access were not copied.";
  }
  if (flag === "invalid") return "Enter a name for the copy (1–200 characters).";
  return undefined;
}

async function publisherShell(db: AppRouteContext["db"], access: SessionUser) {
  const shell = await loadAppShell(db, access);
  return {
    shellLibraries: shell.libraries,
    shellOrphans: shell.orphans,
    shellShelves: shell.shelves,
    username: shell.username,
    roleLabel: shell.roleLabel,
    showAccounts: shell.showAccounts,
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
    {
      includeDetails: library.schema.starter === "table",
      // Readers never receive drafts. Publishers get a change summary on Pending rows.
      review: publishedOnly ? undefined : library.schema,
    },
  );
}

export async function libraryContext(
  db: AppRouteContext["db"],
  libraryId: string,
  access: SessionUser,
): Promise<
  | {
      library: LibraryRow;
      membership: LibraryAccessRow | undefined;
      libraryAccess: SessionUser;
    }
  | { library: LibraryRow; orphan: true }
  | undefined
> {
  const library = await getLibrary(db, libraryId);
  if (!library) return undefined;
  const membership = await getLibraryAccess(db, library.id, access.sub);
  const libraryAccess = accessForLibrary({
    sub: access.sub,
    clientId: access.clientId,
    idpRole: access.role,
    libraryRole: membership?.role,
  });
  if (libraryAccess) {
    return {
      library,
      membership,
      libraryAccess: { ...libraryAccess, csrf: access.csrf },
    };
  }
  const members = await countLibraryAccess(db, library.id);
  if (members === 0 && isSa(access)) {
    return { library, orphan: true };
  }
  return undefined;
}

export function registerLibraryRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  app.get("/", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    const shell = await loadAppShell(db, access);
    res.send(
      librariesPage({
        access,
        csrf: access.csrf,
        libraries: shell.libraries,
        orphans: shell.orphans,
        shelves: shell.shelves,
        username: shell.username,
        roleLabel: shell.roleLabel,
      }),
    );
  });

  app.post("/libraries", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!requireCsrf(req, access.csrf) || !can(access, "libraries.create")) {
      res.status(403).send(errorPage("You cannot add libraries with this account."));
      return;
    }
    const templateRaw = formString(req.body, "template");
    const writeMode = libraryWriteModeFromForm(formString(req.body, "write_mode"));
    const parsed = libraryInputSchema.safeParse({ name: formString(req.body, "name") });
    const customPosted = templateRaw === "custom" ? postedCustomFields(req.body) : undefined;
    const customBuilt =
      customPosted?.ok === true ? customSchemaFromRows(customPosted.rows) : undefined;
    const customError = customPosted && !customPosted.ok
      ? customPosted.message
      : customBuilt && !customBuilt.ok
        ? customBuilt.message
        : undefined;
    if (!parsed.success || !writeMode || customError) {
      const shell = await loadAppShell(db, access);
      res.status(400).send(
        addLibraryPage({
          access,
          csrf: access.csrf,
          libraries: shell.libraries,
          orphans: shell.orphans,
          shelves: shell.shelves,
          username: shell.username,
          roleLabel: shell.roleLabel,
          name: formString(req.body, "name").slice(0, 200),
          template: templateRaw,
          writeMode,
          customFields: customPosted?.ok ? customPosted.rows : undefined,
          error: customError
            ?? (!writeMode
              ? `Choose ${writeModeLabel("reviewed")} or ${writeModeLabel("direct")} for how writes go live.`
              : (parsed.error?.issues[0]?.message ?? "Invalid library")),
        }),
      );
      return;
    }
    const template = templateRaw === "custom" ? "general" : libraryTemplateFromForm(templateRaw);
    const schema = customBuilt?.ok ? customBuilt.schema : undefined;
    const row = await createLibrary(
      db,
      parsed.data.name,
      access.sub,
      template,
      undefined,
      writeMode,
      schema,
    );
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.create_library",
      success: true,
      libraryId: row.id,
      detail: `${row.id}:${row.writeMode}`,
    });
    setConnectReveal(res, config, { libraryId: row.id, sub: access.sub, token: row.connectToken });
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
      libraryId: ctxLib.library.id,
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
    if (!requireCsrf(req, access.csrf) || !can(access, "libraries.create")) {
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
      libraryId: library.id,
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
    if (!can(access, "libraries.create")) {
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
        shelves: shell.shelves,
        username: shell.username,
        roleLabel: shell.roleLabel,
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
          mcpUrl: libraryConnectUrl(config, ctxLib.library),
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
    const notice =
      cancelNotice(req.query.canceled, req.query.canceled_new) ??
      tableDecisionNotice(req.query.table) ??
      fieldDecisionNotice(req.query.field) ??
      writeModeNotice(req.query.mode) ??
      connectNotice(req.query.connect) ??
      readerKeyNotice(req.query["reader-key"]) ??
      renameNotice(req.query.renamed) ??
      shelfMoveNotice(req.query.shelf) ??
      copyNotice(req.query.copied);
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
    const accounts =
      can(ctxLib.libraryAccess, "records.write") && config.authMode === "embedded"
        ? await accountStore(db).list()
        : [];
    const shelfChoices = can(ctxLib.libraryAccess, "records.write") ? await listShelves(db) : [];
    const revealId = readCookie(req.headers, READER_REVEAL_COOKIE, {
      path: readerKeyCookiePath(ctxLib.library.id),
      secure: config.publicBaseUrl.startsWith("https://"),
    });
    let readerKey: string | undefined;
    if (revealId && can(ctxLib.libraryAccess, "records.write")) {
      readerKey = takeReaderKeyReveal(revealId, ctxLib.library.id, access.sub);
      res.append(
        "Set-Cookie",
        cookieHeader(READER_REVEAL_COOKIE, "", {
          clear: true,
          path: readerKeyCookiePath(ctxLib.library.id),
          secure: config.publicBaseUrl.startsWith("https://"),
        }),
      );
      if (readerKey) res.setHeader("Cache-Control", "no-store");
    }
    const connectRevealId = readCookie(req.headers, CONNECT_REVEAL_COOKIE, {
      path: readerKeyCookiePath(ctxLib.library.id),
      secure: config.publicBaseUrl.startsWith("https://"),
    });
    let connectUrl: string | undefined;
    if (connectRevealId) {
      const token = can(ctxLib.libraryAccess, "records.write")
        ? takeConnectReveal(connectRevealId, ctxLib.library.id, access.sub)
        : undefined;
      res.append(
        "Set-Cookie",
        cookieHeader(CONNECT_REVEAL_COOKIE, "", {
          clear: true,
          path: readerKeyCookiePath(ctxLib.library.id),
          secure: config.publicBaseUrl.startsWith("https://"),
        }),
      );
      if (token) {
        connectUrl = libraryMcpUrl(config.publicBaseUrl, ctxLib.library.id, token);
        res.setHeader("Cache-Control", "no-store");
      }
    }
    res.send(
      libraryPage({
        access: ctxLib.libraryAccess,
        csrf: access.csrf,
        library: ctxLib.library,
        items,
        q,
        tab,
        readerKey,
        connectUrl,
        mcpUrl: libraryConnectUrl(config, ctxLib.library),
        accessList,
        accounts,
        viewerSub: access.sub,
        publishedCount,
        notice,
        itemCount,
        reviewDue: can(ctxLib.libraryAccess, "records.write") ? (await reviewQueue(db, ctxLib.library.id)).length : 0,
        canAddLibrary: can(access, "libraries.create"),
        shelfChoices,
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
      libraryId: ctxLib.library.id,
      detail: `${ctxLib.library.id}:${published.length}`,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?published=${published.length}`);
  });

  app.post("/libraries/:id/items/cancel", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can cancel a publish request."));
      return;
    }
    const raw = (req.body as { item_id?: string | string[] } | undefined)?.item_id;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((id) => typeof id === "string");
    const result = await cancelPublishItems(db, ctxLib.library.id, ids, access.sub);
    const canceled = result.restored.length + result.archived.length;
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.cancel_publish",
      success: canceled > 0,
      libraryId: ctxLib.library.id,
      detail: `${ctxLib.library.id}:restored=${result.restored.length}:archived=${result.archived.length}`,
    });
    const params = new URLSearchParams({ tab: "pending" });
    if (canceled > 0) {
      params.set("canceled", String(canceled));
      params.set("canceled_new", String(result.archived.length));
    }
    res.redirect(`/libraries/${ctxLib.library.id}?${params.toString()}`);
  });

  app.post("/libraries/:id/shelf", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can move it to a shelf."));
      return;
    }
    const raw = formString(req.body, "shelf_id").trim();
    const shelfId = raw || null;
    const moved = await setLibraryShelf(db, ctxLib.library.id, shelfId, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.set_library_shelf",
      success: moved.ok,
      libraryId: ctxLib.library.id,
      detail: `${ctxLib.library.id}:${shelfId ?? "none"}`,
    });
    if (!moved.ok) {
      res.redirect(`/libraries/${ctxLib.library.id}?shelf=invalid`);
      return;
    }
    res.redirect(`/libraries/${ctxLib.library.id}?shelf=1`);
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
    const roleRaw = formString(req.body, "role");
    const role: LibraryRole = roleRaw === "publisher" ? "publisher" : "reader";
    const accounts = config.authMode === "embedded" ? await accountStore(db).list() : [];
    try {
      const subject = await resolveGrantSubject(db, config.authMode, req.body);
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
        libraryId: ctxLib.library.id,
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
          mcpUrl: libraryConnectUrl(config, ctxLib.library),
          accessList,
          accounts,
          viewerSub: access.sub,
          error: message,
          tab: "access",
          canAddLibrary: can(access, "libraries.create"),
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
        libraryId: ctxLib.library.id,
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
          mcpUrl: libraryConnectUrl(config, ctxLib.library),
          accessList,
          viewerSub: access.sub,
          error: message,
          tab: "access",
          ...shell,
        }),
      );
    }
  });

  // Kill the Connect link. Access grants stay; people keep their roles.
  app.post("/libraries/:id/connect/rotate", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can rotate the Connect link."));
      return;
    }
    try {
      const updated = await rotateLibraryConnectToken(db, ctxLib.library.id, access.sub);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.rotate_connect",
        success: Boolean(updated),
        libraryId: ctxLib.library.id,
        detail: ctxLib.library.id,
      });
      if (updated) {
        setConnectReveal(res, config, { libraryId: updated.id, sub: access.sub, token: updated.connectToken });
      }
      res.redirect(`/libraries/${ctxLib.library.id}?connect=rotated`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rotate the Connect link";
      const items = await listLibraryItems(db, ctxLib.library, { limit: 50 }, false);
      const accessList = await listLibraryAccess(db, ctxLib.library.id);
      const shell = await publisherShell(db, access);
      res.status(400).send(
        libraryPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          items,
          mcpUrl: libraryConnectUrl(config, ctxLib.library),
          accessList,
          viewerSub: access.sub,
          error: message,
          ...shell,
        }),
      );
    }
  });

  // Issue or rotate the Reader key. The plaintext is shown once on the next page load.
  app.post("/libraries/:id/reader-key", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can create a Reader key."));
      return;
    }
    const issued = await issueLibraryReaderKey(db, ctxLib.library.id, access.sub);
    if (!issued) {
      res.status(404).send(errorPage("Library not found."));
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.reader_key_issue",
      success: true,
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    const revealId = stashReaderKeyReveal({
      libraryId: ctxLib.library.id,
      sub: access.sub,
      key: issued.key,
    });
    res.append(
      "Set-Cookie",
      cookieHeader(READER_REVEAL_COOKIE, revealId, {
        maxAge: 120,
        path: readerKeyCookiePath(ctxLib.library.id),
        secure: config.publicBaseUrl.startsWith("https://"),
      }),
    );
    res.redirect(`/libraries/${ctxLib.library.id}`);
  });

  app.post("/libraries/:id/reader-key/remove", async (req, res) => {
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
      res.status(403).send(errorPage("Only publishers on this library can remove a Reader key."));
      return;
    }
    await clearLibraryReaderKey(db, ctxLib.library.id, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.reader_key_remove",
      success: true,
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?reader-key=removed`);
  });

  app.post("/libraries/:id/rename", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can rename it."));
      return;
    }
    const result = await renameLibrary(db, ctxLib.library.id, formString(req.body, "name"), access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.rename_library",
      success: result.ok,
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    if (!result.ok) {
      res.redirect(`/libraries/${ctxLib.library.id}?renamed=invalid`);
      return;
    }
    res.redirect(`/libraries/${result.library.id}?renamed=1`);
  });

  app.post("/libraries/:id/copy", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can copy its template."));
      return;
    }
    const result = await copyLibraryTemplate(
      db,
      ctxLib.library.id,
      formString(req.body, "name"),
      access.sub,
    );
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.copy_library_template",
      success: result.ok,
      libraryId: ctxLib.library.id,
      detail: result.ok ? `${ctxLib.library.id}->${result.library.id}` : ctxLib.library.id,
    });
    if (!result.ok) {
      res.redirect(`/libraries/${ctxLib.library.id}?copied=invalid`);
      return;
    }
    setConnectReveal(res, config, {
      libraryId: result.library.id,
      sub: access.sub,
      token: result.library.connectToken,
    });
    // Land on the new empty library so the publisher can add fields or items.
    res.redirect(`/libraries/${result.library.id}?copied=1`);
  });

  app.post("/libraries/:id/delete", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("You cannot delete libraries with this account."));
      return;
    }
    const ctxLib = await libraryContext(db, req.params.id, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "libraries.delete")) {
      res.status(403).send(errorPage("Only publishers on this library can delete it."));
      return;
    }
    try {
      const removed = await deleteLibrary(db, ctxLib.library.id);
      await writeAudit(db, {
        actorSub: access.sub,
        tool: "ui.delete_library",
        success: removed,
        libraryId: ctxLib.library.id,
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
        libraryId: ctxLib.library.id,
        detail: ctxLib.library.id,
      });
      const shell = await publisherShell(db, access);
      res.status(400).send(
        libraryPage({
          access: ctxLib.libraryAccess,
          csrf: access.csrf,
          library: ctxLib.library,
          items,
          mcpUrl: libraryConnectUrl(config, ctxLib.library),
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
          canAddLibrary: can(access, "libraries.create"),
          username: shell.username,
          roleLabel: shell.roleLabel,
          showAccounts: shell.showAccounts,
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
      libraryId: ctxLib.library.id,
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
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?table=${removed ? "rejected" : "missing"}`);
  });

  app.post("/libraries/:id/field/approve", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can approve a field."));
      return;
    }
    const result = await approveFieldProposal(db, ctxLib.library.id, access.sub);
    const flag = result.ok
      ? "approved"
      : result.reason === "unreadable"
        ? "unreadable"
        : result.reason === "conflict"
          ? "conflict"
          : result.reason === "at_cap"
            ? "at_cap"
            : "missing";
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.approve_field",
      success: result.ok,
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?field=${flag}`);
  });

  app.post("/libraries/:id/field/reject", async (req, res) => {
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
      res.status(403).send(errorPage("Only a publisher on this library can reject a field."));
      return;
    }
    const removed = await rejectFieldProposal(db, ctxLib.library.id, access.sub);
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.reject_field",
      success: removed,
      libraryId: ctxLib.library.id,
      detail: ctxLib.library.id,
    });
    res.redirect(`/libraries/${ctxLib.library.id}?field=${removed ? "rejected" : "missing"}`);
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
      { aliases: formAliases(req.body) },
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
            canAddLibrary: can(access, "libraries.create"),
            username: shell.username,
            roleLabel: shell.roleLabel,
            showAccounts: shell.showAccounts,
          },
        }),
      );
      return;
    }
    await writeAudit(db, {
      actorSub: access.sub,
      tool: "ui.create",
      success: true,
      libraryId: ctxLib.library.id,
      detail: result.item.id,
    });
    const notice = result.item.status === "published" ? "created_live" : "created";
    res.redirect(`/items/${result.item.id}?notice=${notice}`);
  });
}
