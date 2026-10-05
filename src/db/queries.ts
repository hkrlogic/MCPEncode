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
  deleteLibrary,
  defaultLibraryId,
  resolveLibrary,
} from "./libraries.ts";
export {
  listItems,
  getItem,
  createItem,
  updateItem,
  publishItem,
  unpublishItem,
  archiveItem,
  restoreItem,
  deleteItem,
} from "./items.ts";
export { lookupItems, type LookupResult } from "./lookup.ts";
export { writeAudit, listAudit } from "./audit.ts";
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
export type { LibrarySchemaRow, LibrarySchemaStatus } from "./schemas.ts";
export {
  getPublishedSchema,
  getDraftSchema,
  getEditableSchema,
  saveDraftSchema,
  publishSchema,
} from "./schemas.ts";
export { listFieldValues, replaceFieldValues } from "./field-values.ts";
