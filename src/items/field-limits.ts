/**
 * Default length cap per field type when a field has no own `max`. The MCP tool
 * argument schema, the save check, and new fields from proposals all read this,
 * so they always agree. No imports: safe to use from any items module.
 */
export type FieldLimitType = "text" | "date" | "version" | "longtext" | "markdown";

export const FIELD_TYPE_MAX: Record<FieldLimitType, number> = {
  text: 200,
  date: 10,
  version: 20,
  longtext: 8_000,
  markdown: 50_000,
};

export function fieldMax(field: { type: FieldLimitType; max?: number }): number {
  return field.max ?? FIELD_TYPE_MAX[field.type];
}
