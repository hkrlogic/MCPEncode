/** Libraries for the left pane, including pending counts publishers can act on. */
import { can, type Access } from "../auth/rbac.ts";
import {
  listLibrariesForSubject,
  listOrphanLibraries,
  pendingCountsForPublisher,
} from "../db/queries.ts";
import type { Database } from "../db/types.ts";
import type { AppShell } from "./pages/layout.ts";

type SessionUser = Access & { csrf: string };

export async function loadAppShell(
  db: Database,
  access: SessionUser,
): Promise<Pick<AppShell, "libraries" | "orphans" | "csrf" | "canAddLibrary">> {
  const libraries = await listLibrariesForSubject(db, access.sub);
  // Empty for readers. Publishers only receive counts for libraries they publish.
  const counts = await pendingCountsForPublisher(db, access.sub);
  const canWrite = can(access, "records.write");
  return {
    csrf: access.csrf,
    canAddLibrary: canWrite,
    libraries: libraries.map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
      access_role: row.access_role,
      pendingCount: row.access_role === "publisher" ? (counts.get(row.id) ?? 0) : undefined,
    })),
    orphans: canWrite ? await listOrphanLibraries(db) : [],
  };
}
