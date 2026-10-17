/** Shared row and scope types for library/item DB access. */
import type { FieldProposal } from "../items/field-proposal.ts";
import type { LibrarySchema } from "../items/library-schema.ts";
import type { ItemReview } from "../items/review.ts";
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
  /** Optional field waiting for Approve. Null when nothing is waiting. */
  fieldProposal: FieldProposal | null;
  /** JSON was present but not a valid field proposal. Reject still clears it. */
  fieldProposalUnreadable: boolean;
  /**
   * Last four characters of the Connect token, safe to show ("…a1b2").
   * The token itself is stored only as a SHA-256 hash and is never read back.
   * Rotate to get a new link; access grants stay as they are.
   */
  connectTokenLast4: string | null;
  /**
   * First characters of the Reader key, safe to show.
   * Null when this library has no Reader key. The secret is never stored.
   */
  readerKeyPrefix?: string | null;
  /** When the current Reader key was created. Null when there is no key. */
  readerKeyCreatedAt?: number | null;
  /** Shelf this library is searched with. Null when it stands alone. */
  shelfId?: string | null;
  shelfName?: string | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};

export type ItemStatus = "draft" | "published" | "archived";

/** Last published copy. Live for Readers while an edit is Pending (published_live); also used for Diff and Revert. */
export type PublishedSnapshot = {
  name: string;
  labels: string[];
  summary: string;
  body: string;
  details: string | null;
  published_at: number;
};

/** App-facing item. Columns on disk are name, labels, summary, body, status, entity_key. */
export type ItemRow = {
  id: string;
  library_id: string;
  name: string;
  /** Stable upsert key inside this library. Null when unset. */
  entity_key: string | null;
  labels: string[];
  /** Other words people use for this item (e.g. "phished"). Search matches them like labels. */
  summary: string;
  body: string;
  status: ItemStatus;
  details: string | null;
  published_snapshot: PublishedSnapshot | null;
  /**
   * Published copy from before the last Publish / Unlock save that changed content.
   * Lets Revert undo an accidental publish. One deep — not full history.
   */
  previous_published_snapshot: PublishedSnapshot | null;
  /**
   * Review Lock: an edit is Pending while the last published copy stays live
   * for Readers and agents. On the working row, status is draft; on the live
   * view, status is published and the text is the published copy.
   */
  has_pending_changes?: boolean;
  /** "working" = the row as edited; "live" = what Readers and agents see. */
  view?: "working" | "live";
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
  entity_key: string | null;
  labels: string[];
  summary: string;
  status: ItemStatus;
  updated_at: number;
  /** Pending edit on a live item. Set only for editor (non-Reader) lists. */
  has_pending_changes?: boolean;
  /**
   * Column values for a table library. Set only when a list asks for them.
   * Absent on the normal catalog list so MCP stays a summary.
   */
  values?: Record<string, string>;
  /**
   * What changed since the last publish. Set only for Pending rows on the
   * publisher list. MCP summaries omit it.
   */
  review?: ItemReview;
};

export type AuditRow = {
  id: string;
  actor_sub: string;
  /** Username of the actor (built-in accounts), "Reader key", or the subject. */
  actor: string;
  tool: string;
  success: boolean;
  detail: string;
  created_at: number;
};

export type ReadScope = {
  /**
   * Reader path: only what is live (published, or the published copy of an
   * item whose edit is Pending). Editors pass false and can see drafts.
   */
  publishedOnly: boolean;
  /**
   * Editors only: read what Readers see (published copy while an edit is
   * Pending) instead of the working row. Never-published drafts stay visible.
   */
  live?: boolean;
};
