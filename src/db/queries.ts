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
  renameLibrary,
  copyLibraryTemplate,
  suggestedCopyName,
  rotateLibraryConnectToken,
  getLibraryReaderKeyHash,
  getLibraryConnectTokenHash,
  issueLibraryReaderKey,
  clearLibraryReaderKey,
  setLibraryWriteMode,
  deleteLibrary,
  defaultLibraryId,
  resolveLibrary,
} from "./libraries.ts";
export {
  listItems,
  getItem,
  getLibraryItem,
  getItemByEntityKey,
  createItem,
  addDraftItem,
  countLibraryItems,
  updateItem,
  publishItem,
  publishItems,
  cancelPublishItem,
  cancelPublishItems,
  unpublishItem,
  archiveItem,
  restoreItem,
  revertToPublished,
  deleteItem,
} from "./items.ts";
export type { RevertToPublishedResult, CancelPublishResult } from "./items.ts";
export {
  canRevertToPublished,
  itemDiffersFromSnapshot,
  previousSnapshotAfterPublish,
  revertPlan,
} from "./query-helpers.ts";
export type { RevertKind, RevertPlan } from "./query-helpers.ts";
export { lookupItems, type LookupResult } from "./lookup.ts";
export {
  addItemFile,
  listItemFiles,
  getItemFile,
  removeItemFile,
  type ItemFileMeta,
  type AddFileResult,
  type RemoveFileResult,
} from "./files.ts";
export { writeAudit, listAudit } from "./audit.ts";
export {
  listShelves,
  getShelf,
  createShelf,
  renameShelf,
  deleteShelf,
  setLibraryShelf,
  listShelfLibraries,
  searchShelf,
} from "./shelves.ts";
export type { ShelfRow, ShelfHit } from "./shelves.ts";
export { proposeTable, approveTableProposal, rejectTableProposal } from "./table-proposals.ts";
export type { ProposeTableResult, ApproveTableResult } from "./table-proposals.ts";
export { proposeField, approveFieldProposal, rejectFieldProposal } from "./field-proposals.ts";
export type { ProposeFieldResult, ApproveFieldResult } from "./field-proposals.ts";
export type { LibraryAccessRole, LibraryAccessRow } from "./access.ts";
export { accountStore } from "./accounts.ts";
export {
  listLibraryAccess,
  getLibraryAccess,
  countLibraryAccess,
  listLibrariesForSubject,
  listAllLibrariesForSa,
  pendingCountsForPublisher,
  publishedCountsForSubject,
  listOrphanLibraries,
  grantLibraryAccess,
  revokeLibraryAccess,
} from "./access.ts";
