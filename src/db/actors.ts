/** Turn stored actor subjects (account ids) into names people recognise. */
import { readerKeySubject } from "../auth/reader-key.ts";
import { allRows } from "./query-helpers.ts";
import type { Database } from "./types.ts";

/**
 * Display name for each subject: the account's username, "Reader key" for a
 * library Reader key, otherwise the subject itself (an external IdP subject or
 * "system"). Unknown subjects fall back to the raw value, never to blank.
 */
export async function actorNames(db: Database, subjects: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...subjects].filter((s): s is string => typeof s === "string" && s !== ""))];
  const names = new Map<string, string>();
  if (wanted.length === 0) return names;
  const rows = await allRows<{ id: string; username: string }>(
    db,
    "SELECT id, username FROM accounts WHERE id = ANY(?::text[])",
    wanted,
  );
  for (const row of rows) names.set(row.id, row.username);
  for (const sub of wanted) {
    if (names.has(sub)) continue;
    names.set(sub, sub.startsWith(readerKeySubject("")) ? "Reader key" : sub);
  }
  return names;
}

export async function actorName(db: Database, subject: string | null | undefined): Promise<string> {
  if (!subject) return "";
  return (await actorNames(db, [subject])).get(subject) ?? subject;
}
