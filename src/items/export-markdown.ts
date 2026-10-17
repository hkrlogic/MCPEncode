/**
 * Clean Markdown export for one item — no publisher chrome, status, or ids.
 * Suitable for download and paste into other writing tools.
 */
import type { ItemRow, LibraryRow } from "../db/models.ts";
import { parseTableValues, tableControl, tableParts } from "./table-proposal.ts";
import {
  policyBody,
  policyControl,
  procedureBody,
  procedureControl,
} from "./templates.ts";

/** Safe download basename from the item name (no path segments). */
export function markdownExportFilename(name: string): string {
  const base = (typeof name === "string" ? name : "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.md$/i, "")
    .replace(/\.+$/g, "")
    .slice(0, 80)
    .trim();
  return `${base || "item"}.md`;
}

function escapeHeading(text: string): string {
  // Avoid breaking out of the H1 if the name starts with #.
  return text.replace(/^\s*#+\s*/, "").trim() || "Untitled";
}

function detailsBlock(
  control: { label: string; value: string }[],
  parts: { label: string; text: string }[],
): string {
  const lines: string[] = [];
  if (control.length > 0) {
    for (const row of control) {
      lines.push(`**${row.label}:** ${row.value}`);
    }
    lines.push("");
  }
  for (const part of parts) {
    lines.push(`## ${part.label}`, "", part.text.trim(), "");
  }
  return lines.join("\n").trim();
}

/** Full Markdown document for one item. */
export function itemToMarkdown(item: ItemRow, library: LibraryRow): string {
  const name = typeof item.name === "string" ? item.name : "";
  const summary = typeof item.summary === "string" ? item.summary.trim() : "";
  const bodyText = typeof item.body === "string" ? item.body.trim() : "";
  const labels = Array.isArray(item.labels)
    ? item.labels.filter((label): label is string => typeof label === "string" && label.trim() !== "")
    : [];

  const chunks: string[] = [`# ${escapeHeading(name)}`, ""];
  if (summary) {
    chunks.push(summary, "");
  }
  if (labels.length > 0) {
    chunks.push(`Labels: ${labels.join(", ")}`, "");
  }

  const starter = library.schema?.starter ?? "general";
  const fields = Array.isArray(library.schema?.fields) ? library.schema.fields : [];
  if (starter === "table") {
    const values = parseTableValues(item.details) ?? {};
    const body = detailsBlock(tableControl(fields, values), tableParts(fields, values));
    if (body) chunks.push(body, "");
  } else if (starter === "policy" && item.policy) {
    chunks.push(detailsBlock(policyControl(item.policy), policyBody(item.policy)), "");
  } else if (starter === "procedure" && item.procedure) {
    chunks.push(detailsBlock(procedureControl(item.procedure), procedureBody(item.procedure)), "");
  } else if (bodyText) {
    chunks.push(bodyText, "");
  }

  return `${chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
