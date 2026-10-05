/** Assemble agent/UI presentation for an item, including typed custom fields. */
import type { Database } from "../db/types.ts";
import { listFieldValues } from "../db/field-values.ts";
import { getPublishedSchema } from "../db/schemas.ts";
import type { ItemRow } from "../db/models.ts";
import { labeledFieldValues } from "./library-schema.ts";
import { labeledItemData } from "../markdown/render.ts";

/** Load typed values and return labeled wire text for MCP. */
export async function presentItem(db: Database, item: ItemRow): Promise<string> {
  const schema = await getPublishedSchema(db, item.library_id);
  const values = await listFieldValues(db, item.id);
  const fieldsBlock =
    schema && values.length > 0
      ? labeledFieldValues(schema.fields, values)
      : schema
        ? labeledFieldValues(schema.fields, values)
        : "";
  return labeledItemData({
    id: item.id,
    library_id: item.library_id,
    name: item.name,
    labels: item.labels,
    summary: item.summary,
    body: item.body,
    fieldsBlock: fieldsBlock || undefined,
  });
}
