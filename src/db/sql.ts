/**
 * Split a migration file into single statements.
 * The driver runs one statement at a time. Multiple statements on one
 * call stay off, so a value from a form can never sneak in a second command.
 * Semicolons inside quotes or comments are not boundaries.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let quote: "'" | '"' | "`" | null = null;

  while (i < sql.length) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1] ?? "";

    if (quote) {
      current += ch;
      if (ch === "\\" && quote !== "`") {
        current += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

/** records is kept on purpose. A migration must not drop any table. */
export function assertNoDropTable(statement: string): void {
  if (/\bdrop\s+table\b/i.test(statement)) {
    throw new Error("Refusing to drop a table. records is kept.");
  }
}
