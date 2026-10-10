/** Libraries for the left pane, including pending counts publishers can act on. */
import { can, isSa, type Access } from "../auth/rbac.ts";
import { accountStore } from "../db/accounts.ts";
import {
  listAllLibrariesForSa,
  listLibrariesForSubject,
  listOrphanLibraries,
  listShelves,
  pendingCountsForPublisher,
  publishedCountsForSubject,
} from "../db/queries.ts";
import type { Database } from "../db/types.ts";
import { isLibraryWriteMode } from "../items/schema.ts";
import type { AppShell } from "./pages/layout.ts";

type SessionUser = Access & { csrf: string };

/** Display name for the sidebar footer. Prefer the account username; fall back for OIDC. */
function displayName(access: Access, username: string | undefined): string {
  if (username) return username;
  const sub = access.sub.trim();
  if (sub.includes("@")) {
    const local = sub.split("@")[0] ?? sub;
    return local || sub;
  }
  return sub.length > 12 ? `${sub.slice(0, 8)}…` : sub || "Signed in";
}

export async function loadAppShell(
  db: Database,
  access: SessionUser,
): Promise<
  Pick<
    AppShell,
    | "libraries"
    | "orphans"
    | "shelves"
    | "csrf"
    | "canAddLibrary"
    | "showAccounts"
    | "username"
    | "roleLabel"
  >
> {
  const sa = isSa(access);
  const libraries = sa
    ? await listAllLibrariesForSa(db)
    : await listLibrariesForSubject(db, access.sub);
  const [pending, published, account, shelves] = await Promise.all([
    pendingCountsForPublisher(db, access.sub, { everyLibrary: sa }),
    publishedCountsForSubject(db, access.sub, { everyLibrary: sa }),
    accountStore(db).findById(access.sub),
    listShelves(db),
  ]);
  const mapped = libraries.map((row) => ({
    id: row.id,
    name: row.name,
    template: row.template,
    writeMode: isLibraryWriteMode(row.write_mode) ? row.write_mode : ("reviewed" as const),
    access_role: row.access_role,
    shelfId: row.shelf_id,
    shelfName: row.shelf_name,
    itemCount: published.get(row.id) ?? 0,
    pendingCount:
      sa || row.access_role === "publisher" ? (pending.get(row.id) ?? 0) : undefined,
  }));
  const visibleShelfIds = new Set(
    mapped.map((row) => row.shelfId).filter((id): id is string => Boolean(id)),
  );
  return {
    csrf: access.csrf,
    canAddLibrary: can(access, "libraries.create"),
    showAccounts: can(access, "accounts.manage"),
    username: displayName(access, account?.username),
    // App admin flag only — library Access carries reader/publisher.
    roleLabel: sa ? "SA" : "",
    libraries: mapped,
    shelves: (sa ? shelves : shelves.filter((shelf) => visibleShelfIds.has(shelf.id))).map(
      (shelf) => ({ id: shelf.id, name: shelf.name }),
    ),
    orphans: sa ? await listOrphanLibraries(db) : [],
  };
}
