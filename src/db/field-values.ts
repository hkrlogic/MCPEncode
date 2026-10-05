/** Typed custom-field values for library items (item_field_values). */
import type { Database } from "./types.ts";
import type { TypedFieldValue } from "../items/library-schema.ts";
import { allRows, runSql } from "./query-helpers.ts";

type SqlValue = {
  item_id: string;
  field_key: string;
  value_string: string | null;
  value_number: number | null;
  value_date: string | Date | null;
  value_boolean: number | boolean | null;
};

function toTyped(row: SqlValue): TypedFieldValue {
  let value_date: string | null = null;
  if (row.value_date instanceof Date) {
    value_date = row.value_date.toISOString().slice(0, 10);
  } else if (typeof row.value_date === "string" && row.value_date) {
    value_date = row.value_date.slice(0, 10);
  }
  let value_boolean: boolean | null = null;
  if (row.value_boolean === true || row.value_boolean === 1) value_boolean = true;
  else if (row.value_boolean === false || row.value_boolean === 0) value_boolean = false;

  return {
    field_key: row.field_key,
    value_string: row.value_string,
    value_number: row.value_number === null || row.value_number === undefined ? null : Number(row.value_number),
    value_date,
    value_boolean,
  };
}

export async function listFieldValues(db: Database, itemId: string): Promise<TypedFieldValue[]> {
  const rows = await allRows<SqlValue>(
    db,
    `SELECT item_id, field_key, value_string, value_number, value_date, value_boolean
     FROM item_field_values
     WHERE item_id = ?
     ORDER BY field_key ASC`,
    itemId,
  );
  return rows.map(toTyped);
}

/** Replace all typed values for one item (delete + insert). */
export async function replaceFieldValues(
  db: Database,
  itemId: string,
  rows: TypedFieldValue[],
): Promise<void> {
  await runSql(db, "DELETE FROM item_field_values WHERE item_id = ?", itemId);
  for (const row of rows) {
    await runSql(
      db,
      `INSERT INTO item_field_values (
         item_id, field_key, value_string, value_number, value_date, value_boolean
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      itemId,
      row.field_key,
      row.value_string,
      row.value_number,
      row.value_date,
      row.value_boolean === null ? null : row.value_boolean ? 1 : 0,
    );
  }
}
