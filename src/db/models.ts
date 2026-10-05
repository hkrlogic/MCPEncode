/** Shared row and scope types for library/item DB access. */
import type { LibraryTemplate, PolicyDetails, ProcedureDetails } from "../items/templates.ts";
import type { TypedFieldValue } from "../items/library-schema.ts";

export type LibraryRow = {
  id: string;
  name: string;
  template: LibraryTemplate;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type ItemStatus = "draft" | "published" | "archived";

/** Last published copy. Used for Diff after an edit unpublishes; MCP still reads live columns. */
export type PublishedSnapshot = {
  name: string;
  labels: string[];
  summary: string;
  body: string;
  details: string | null;
  published_at: number;
};

/** App-facing item. Columns on disk are name, labels, summary, body, status. */
export type ItemRow = {
  id: string;
  library_id: string;
  name: string;
  labels: string[];
  summary: string;
  body: string;
  status: ItemStatus;
  details: string | null;
  published_snapshot: PublishedSnapshot | null;
  policy?: PolicyDetails;
  procedure?: ProcedureDetails;
  /** Custom field values when the library has a published schema. */
  field_values?: TypedFieldValue[];
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type ItemSummary = {
  id: string;
  library_id: string;
  name: string;
  labels: string[];
  summary: string;
  status: ItemStatus;
  updated_at: number;
};

export type AuditRow = {
  id: string;
  actor_sub: string;
  tool: string;
  success: boolean;
  detail: string;
  created_at: number;
};

export type ReadScope = {
  /** Reader path: only status = 'published'. Editors pass false and can see drafts. */
  publishedOnly: boolean;
};
