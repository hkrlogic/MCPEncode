/**
 * GitHub-flavored Markdown tables. The UI grid writes this format; MCP
 * and the item preview read the same string. Cells never store HTML.
 */

export type MdTable = {
  headers: string[];
  rows: string[][];
};

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ").trim();
}

function unescapeCell(value: string): string {
  return value.replaceAll("\\|", "|").trim();
}

function usedWidth(headers: string[], rows: string[][]): number {
  const width = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  let last = -1;
  for (let index = 0; index < width; index += 1) {
    if ((headers[index] ?? "").trim() || rows.some((row) => (row[index] ?? "").trim())) {
      last = index;
    }
  }
  return last + 1;
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map(unescapeCell);
}

function isSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(" ", "")));
}

export function markdownFromTable(table: MdTable): string {
  const width = usedWidth(table.headers, table.rows);
  if (width === 0) return "";
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? ""));
  const headers = pad(table.headers).map((cell) => cell || " ");
  const rows = table.rows
    .map(pad)
    .filter((row) => row.some((cell) => cell.length > 0 && cell !== " "));
  const separator = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Returns a table only when the whole body is a Markdown table (no extra prose). */
export function parseMarkdownTable(source: string): MdTable | undefined {
  const lines = source
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !isSeparator(lines[1])) return undefined;
  if (!lines.every((line) => line.includes("|"))) return undefined;
  const headers = splitRow(lines[0]);
  if (headers.length === 0) return undefined;
  const rows = lines.slice(2).map(splitRow);
  return { headers, rows };
}

/** Split an item body into Summary (leading prose) and a Table or Description section. */
export function splitSummaryAndTable(source: string): {
  summary: string;
  table: MdTable | undefined;
  description: string;
} {
  const raw = source.replaceAll("\r\n", "\n");
  const lines = raw.split("\n");
  let tableAt = -1;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index]?.includes("|")) continue;
    if (isSeparator(lines[index + 1] ?? "")) {
      tableAt = index;
      break;
    }
  }
  if (tableAt === -1) {
    const trimmed = raw.trim();
    const parts = trimmed.match(/^(.+?)(?:\n\s*\n)([\s\S]+)$/);
    if (parts) {
      return {
        summary: parts[1].replaceAll("\n", " ").trim(),
        table: undefined,
        description: parts[2].trim(),
      };
    }
    return { summary: "", table: undefined, description: trimmed };
  }
  const summary = lines.slice(0, tableAt).join("\n").trim();
  let tableEnd = tableAt + 2;
  while (tableEnd < lines.length && (lines[tableEnd] ?? "").includes("|")) {
    tableEnd += 1;
  }
  const tableSource = lines.slice(tableAt, tableEnd).join("\n");
  const table = parseMarkdownTable(tableSource);
  const after = lines.slice(tableEnd).join("\n").trim();
  return {
    summary,
    table,
    description: table ? after : [tableSource, after].filter(Boolean).join("\n\n").trim(),
  };
}

/** Put Summary first so list/search excerpts stay useful. */
/**
 * Documents store the summary as the body's first paragraph. Pages and agents
 * already show the summary on its own, so drop that paragraph when it is the
 * summary, instead of printing it twice.
 */
export function bodyWithoutSummary(body: string, summary: string | null | undefined): string {
  const lead = (summary ?? "").trim();
  const text = body.replaceAll("\r\n", "\n").trim();
  if (!lead || !text.startsWith(lead)) return body;
  const rest = text.slice(lead.length);
  if (rest !== "" && !/^\s*\n\s*\n/.test(rest)) return body;
  return rest.trim();
}

export function combineSummaryAndBody(summary: string, body: string): string {
  const lead = summary.trim();
  const rest = body.trim();
  if (lead && rest) return `${lead}\n\n${rest}`;
  return lead || rest;
}

export const EMPTY_TABLE: MdTable = {
  headers: ["", ""],
  rows: [
    ["", ""],
    ["", ""],
  ],
};

/** First spreadsheet row is the Markdown header row. */
export function tableToSheetData(table: MdTable, minCols = 6, minRows = 10): string[][] {
  const width = Math.max(minCols, table.headers.length, ...table.rows.map((row) => row.length));
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => row[index] ?? "");
  const data = [pad(table.headers), ...table.rows.map(pad)];
  while (data.length < minRows) {
    data.push(Array.from({ length: width }, () => ""));
  }
  return data;
}

export function sheetDataToTable(data: unknown): MdTable {
  if (!Array.isArray(data) || data.length === 0) return EMPTY_TABLE;
  const rows = data.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [],
  );
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const width = usedWidth(headers, body);
  if (width === 0) return EMPTY_TABLE;
  const slice = (row: string[]): string[] => row.slice(0, width);
  return { headers: slice(headers), rows: body.map(slice) };
}
