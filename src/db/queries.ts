/** Public DB API barrel — existing imports keep using this path. */
export type {
  LibraryRow,
  ItemStatus,
  PublishedSnapshot,
  ItemRow,
  ItemSummary,
  AuditRow,
  ReadScope,
} from "./models.ts";
export {
  listLibraries,
  getLibrary,
  createLibrary,
  setLibraryWriteMode,
  deleteLibrary,
  defaultLibraryId,
  resolveLibrary,
} from "./libraries.ts";
export {
  listItems,
  getItem,
  createItem,
  addDraftItem,
  countLibraryItems,
  updateItem,
  publishItem,
  publishItems,
  unpublishItem,
  archiveItem,
  restoreItem,
  deleteItem,
} from "./items.ts";
export { lookupItems, type LookupResult } from "./lookup.ts";
export { writeAudit, listAudit } from "./audit.ts";
export { proposeTable, approveTableProposal, rejectTableProposal } from "./table-proposals.ts";
export type { ProposeTableResult, ApproveTableResult } from "./table-proposals.ts";
export type { LibraryAccessRole, LibraryAccessRow } from "./access.ts";
export {
  listLibraryAccess,
  getLibraryAccess,
  countLibraryAccess,
  listLibrariesForSubject,
  listOrphanLibraries,
  grantLibraryAccess,
  revokeLibraryAccess,
} from "./access.ts";
