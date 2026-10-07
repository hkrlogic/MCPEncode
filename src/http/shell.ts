/** Libraries for the left pane, including pending counts publishers can act on. */
import { can, isSa, type Access } from "../auth/rbac.ts";
import {
  listAllLibrariesForSa,
  listLibrariesForSubject,
  listOrphanLibraries,
  pendingCountsForPublisher,
} from "../db/queries.ts";
import type { Database } from "../db/types.ts";
import { isLibraryWriteMode } from "../items/schema.ts";
import type { AppShell } from "./pages/layout.ts";

type SessionUser = Access & { csrf: string };

export async function loadAppShell(
  db: Database,
  access: SessionUser,
): Promise<Pick<AppShell, "libraries" | "orphans" | "csrf" | "canAddLibrary" | "showAccounts">> {
  const sa = isSa(access);
  const libraries = sa
    ? await listAllLibrariesForSa(db)
    : await listLibrariesForSubject(db, access.sub);
  const counts = await pendingCountsForPublisher(db, access.sub, { everyLibrary: sa });
  return {
    csrf: access.csrf,
    canAddLibrary: can(access, "libraries.create"),
    showAccounts: can(access, "accounts.manage"),
    libraries: libraries.map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
      writeMode: isLibraryWriteMode(row.write_mode) ? row.write_mode : "reviewed",
      access_role: row.access_role,
      pendingCount:
        sa || row.access_role === "publisher" ? (counts.get(row.id) ?? 0) : undefined,
    })),
    orphans: sa ? await listOrphanLibraries(db) : [],
  };
}
