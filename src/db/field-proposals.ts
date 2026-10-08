/**
 * Store, approve, or reject one pending optional field on a library.
 * Approval is a portal action. MCP only calls proposeField.
 */
import {
  normalizeFieldProposal,
  parseStoredFieldProposal,
  schemaWithApprovedField,
  type FieldProposal,
  type ProposeFieldInput,
} from "../items/field-proposal.ts";
import type { LibrarySchema } from "../items/library-schema.ts";
import { librarySchemaOf } from "../items/library-schema.ts";
import { isLibraryTemplate } from "../items/templates.ts";
import type { Database } from "./types.ts";
import { getRow, runSql } from "./query-helpers.ts";

export type ProposeFieldResult =
  | { ok: true; proposal: FieldProposal }
  | { ok: false; message: string };

export type ApproveFieldResult =
  | { ok: true; schema: LibrarySchema }
  | { ok: false; reason: "not_found" | "missing" | "unreadable" | "conflict" };

type LockedLibrary = {
  id: string;
  template: string;
  schema: unknown;
  table_proposal: unknown;
  field_proposal: unknown;
};

function schemaOfRow(row: LockedLibrary): LibrarySchema {
  const template =
    row.template && isLibraryTemplate(row.template) ? row.template : "general";
  return librarySchemaOf(template, row.schema);
}

/** Save one optional field proposal. Does not change the live schema. */
export async function proposeField(
  db: Database,
  libraryId: string,
  input: ProposeFieldInput,
  actorSub: string,
): Promise<ProposeFieldResult> {
  return db.transaction(async (tx) => {
    const row = await getRow<LockedLibrary>(
      tx,
      "SELECT id, template, schema, table_proposal, field_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row) return { ok: false, message: "Library not found." };
    if (row.table_proposal != null) {
      return {
        ok: false,
        message:
          "A table is already waiting for approval in the publisher. Approve or Reject it before proposing a field.",
      };
    }
    if (row.field_proposal != null) {
      return {
        ok: false,
        message:
          "A field is already waiting for approval in the publisher. A human must Approve or Reject it there before another can be proposed.",
      };
    }
    const schema = schemaOfRow(row);
    const normalized = normalizeFieldProposal(input, schema);
    if (!normalized.ok) return normalized;
    const proposal: FieldProposal = {
      ...normalized.draft,
      proposedBy: actorSub,
      proposedAt: Date.now(),
    };
    await runSql(
      tx,
      "UPDATE libraries SET field_proposal = ?::jsonb, updated_by = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(proposal),
      actorSub,
      proposal.proposedAt,
      libraryId,
    );
    return { ok: true, proposal };
  });
}

/**
 * Append the waiting field onto the library schema.
 * Refuses when the key already exists (integrity) or the proposal is unreadable.
 */
export async function approveFieldProposal(
  db: Database,
  libraryId: string,
  actorSub: string,
): Promise<ApproveFieldResult> {
  return db.transaction(async (tx) => {
    const row = await getRow<LockedLibrary>(
      tx,
      "SELECT id, template, schema, table_proposal, field_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row) return { ok: false, reason: "not_found" };
    const stored = parseStoredFieldProposal(row.field_proposal);
    if (stored.unreadable) return { ok: false, reason: "unreadable" };
    if (!stored.proposal) return { ok: false, reason: "missing" };
    const schema = schemaOfRow(row);
    if (schema.fields.some((field) => field.key === stored.proposal!.key)) {
      return { ok: false, reason: "conflict" };
    }
    const next = schemaWithApprovedField(schema, stored.proposal);
    const now = Date.now();
    await runSql(
      tx,
      `UPDATE libraries
       SET schema = ?::jsonb, field_proposal = NULL, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      JSON.stringify(next),
      actorSub,
      now,
      libraryId,
    );
    return { ok: true, schema: next };
  });
}

/** Drop the waiting field. The live schema stays as it was. */
export async function rejectFieldProposal(
  db: Database,
  libraryId: string,
  actorSub: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await getRow<{ id: string; field_proposal: unknown }>(
      tx,
      "SELECT id, field_proposal FROM libraries WHERE id = ? FOR UPDATE",
      libraryId,
    );
    if (!row || row.field_proposal == null) return false;
    await runSql(
      tx,
      "UPDATE libraries SET field_proposal = NULL, updated_by = ?, updated_at = ? WHERE id = ?",
      actorSub,
      Date.now(),
      libraryId,
    );
    return true;
  });
}
