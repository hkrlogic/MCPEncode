/** Shared row and scope types for library/item DB access. */
import type { LibrarySchema } from "../items/library-schema.ts";
import type { LibraryWriteMode } from "../items/schema.ts";
import type { TableProposal } from "../items/table-proposal.ts";
import type { LibraryTemplate, PolicyDetails, ProcedureDetails } from "../items/templates.ts";

export type LibraryRow = {
  id: string;
  name: string;
  /** Starter id used when the library was created (UI kicker / copy). */
  template: LibraryTemplate;
  /**
   * How writes become visible.
   * reviewed = Pending until Publish; direct = successful saves are Published.
   */
  writeMode: LibraryWriteMode;
  /** Field contract copied from the starter at create, or from an approved table. */
  schema: LibrarySchema;
  /** Table waiting for a publisher to approve in the portal. Null when nothing is waiting. */
  tableProposal: TableProposal | null;
  /** JSON was present but not a valid proposal. Reject still clears it. */
  tableProposalUnreadable: boolean;
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
