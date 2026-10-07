/** Libraries for the left pane, including pending counts publishers can act on. */
import { can, isSa, type Access } from "../auth/rbac.ts";
import { accountStore } from "../db/accounts.ts";
import {
  listAllLibrariesForSa,
  listLibrariesForSubject,
  listOrphanLibraries,
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
  const [pending, published, account] = await Promise.all([
    pendingCountsForPublisher(db, access.sub, { everyLibrary: sa }),
    publishedCountsForSubject(db, access.sub, { everyLibrary: sa }),
    accountStore(db).findById(access.sub),
  ]);
  return {
    csrf: access.csrf,
    canAddLibrary: can(access, "libraries.create"),
    showAccounts: can(access, "accounts.manage"),
    username: displayName(access, account?.username),
    // App role in the footer — not the per-library publisher/reader label.
    roleLabel: sa ? "SA" : "Reader",
    libraries: libraries.map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
      writeMode: isLibraryWriteMode(row.write_mode) ? row.write_mode : "reviewed",
      access_role: row.access_role,
      itemCount: published.get(row.id) ?? 0,
      pendingCount:
        sa || row.access_role === "publisher" ? (pending.get(row.id) ?? 0) : undefined,
    })),
    orphans: sa ? await listOrphanLibraries(db) : [],
  };
}
