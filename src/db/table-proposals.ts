/**
 * Store, approve, or reject one pending table on a library.
 * Approval is a portal action. MCP only calls proposeTable.
 */
import type { LibrarySchema } from "../items/library-schema.ts";
import {
  normalizeTableProposal,
  parseStoredTableProposal,
  schemaFromProposal,
  type ProposeTableInput,
  type TableProposal,
} from "../items/table-proposal.ts";
import type { Database } from "./types.ts";
import { getRow, runSql } from "./query-helpers.ts";

export type ProposeTableResult =
  | { ok: true; proposal: TableProposal }
  | { ok: false; message: string };

export type ApproveTableResult =
  | { ok: true; schema: LibrarySchema }
  | { ok: false; reason: "not_found" | "missing" | "unreadable" | "has_items" };

async function itemCount(db: Database, libraryId: string): Promise<number> {
  const row = await getRow<{ n: string | number }>(
    db,
    "SELECT COUNT(*) AS n FROM items WHERE library_id = ?",
    libraryId,
  );
  return Number(row?.n ?? 0);
}

/** Save a proposal. Fails when one is already waiting. Does not change the live schema. */
export async function proposeTable(
  db: Database,
  libraryId: string,
  input: ProposeTableInput,
  actorSub: string,
): Promise<ProposeTableResult> {
  const normalized = normalizeTableProposal(input);
  if (!normalized.ok) return normalized;
  const proposal: TableProposal = {
    ...normalized.draft,
    proposedBy: actorSub,
    proposedAt: Date.now(),
  };
  return db.transaction(async (tx) => {
    const row = await getRow<{ id: string; table_proposal: unknown; field_proposal: unknown }>(
      tx,
      "SELECT id, table_proposal, field_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row) return { ok: false, message: "Library not found." };
    if (row.field_proposal != null) {
      return {
        ok: false,
        message:
          "A field is already waiting for approval in the publisher. Approve or Reject it before proposing a table.",
      };
    }
    if (row.table_proposal != null) {
      return {
        ok: false,
        message:
          "A table is already waiting for approval in the publisher. A human must approve or reject it there before another can be proposed.",
      };
    }
    await runSql(
      tx,
      "UPDATE libraries SET table_proposal = ?::jsonb, updated_by = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(proposal),
      actorSub,
      proposal.proposedAt,
      libraryId,
    );
    return { ok: true, proposal };
  });
}

/**
 * Copy the waiting table onto the library schema.
 * Refuses when the library already has items, so existing items are not left on the old columns.
 */
export async function approveTableProposal(
  db: Database,
  libraryId: string,
  actorSub: string,
): Promise<ApproveTableResult> {
  return db.transaction(async (tx) => {
    const row = await getRow<{ id: string; table_proposal: unknown }>(
      tx,
      "SELECT id, table_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row) return { ok: false, reason: "not_found" };
    const stored = parseStoredTableProposal(row.table_proposal);
    if (stored.unreadable) return { ok: false, reason: "unreadable" };
    if (!stored.proposal) return { ok: false, reason: "missing" };
    if ((await itemCount(tx, libraryId)) > 0) return { ok: false, reason: "has_items" };
    const schema = schemaFromProposal(stored.proposal);
    const now = Date.now();
    await runSql(
      tx,
      `UPDATE libraries
       SET template = 'table', schema = ?::jsonb, table_proposal = NULL, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      JSON.stringify(schema),
      actorSub,
      now,
      libraryId,
    );
    return { ok: true, schema };
  });
}

/** Drop the waiting table. The live schema stays as it was. */
export async function rejectTableProposal(
  db: Database,
  libraryId: string,
  actorSub: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await getRow<{ id: string; table_proposal: unknown }>(
      tx,
      "SELECT id, table_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row || row.table_proposal == null) return false;
    await runSql(
      tx,
      "UPDATE libraries SET table_proposal = NULL, updated_by = ?, updated_at = ? WHERE id = ?",
      actorSub,
      Date.now(),
      libraryId,
    );
    return true;
  });
}
