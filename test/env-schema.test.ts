/**
 * The env schema (src/env-schema.ts), the code that reads the environment and
 * the table in docs/deploy.md must list the same variables.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALIAS_ENV_VARS, ENV_VARS, REMOVED_ENV_VARS } from "../src/env-schema.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Names the app reads: process.env.X, envValue("X") and required("X"). */
function namesReadBySource(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)|(?:envValue|required)\("([A-Z_][A-Z0-9_]*)"\)/g)) {
      names.add(match[1] ?? match[2]);
    }
  }
  return names;
}

test("every variable the code reads is in the env schema, and the other way round", () => {
  const read = namesReadBySource();
  const listed = new Set([...ENV_VARS.map((v) => v.name), ...ALIAS_ENV_VARS]);
  assert.deepEqual([...read].filter((name) => !listed.has(name)).sort(), [], "read by src/ but not in src/env-schema.ts");
  assert.deepEqual([...listed].filter((name) => !read.has(name)).sort(), [], "in src/env-schema.ts but never read");
  for (const name of REMOVED_ENV_VARS) assert.equal(read.has(name), false, `${name} is removed but still read`);
});

test("docs/deploy.md has one table row per variable with the schema default", () => {
  const doc = readFileSync("docs/deploy.md", "utf8");
  for (const v of ENV_VARS) {
    const row = doc.split("\n").find((line) => line.startsWith(`| \`${v.name}\` |`));
    assert.ok(row, `docs/deploy.md is missing a row for ${v.name}`);
    if (v.default) assert.ok(row.includes(`\`${v.default}\``), `${v.name} default in docs/deploy.md is not ${v.default}`);
  }
  for (const name of REMOVED_ENV_VARS) {
    assert.equal(doc.includes(`| \`${name}\` |`), false, `${name} is removed but still has a table row`);
  }
});

test(".env.example only sets known variables", () => {
  const known = new Set(ENV_VARS.map((v) => v.name));
  for (const line of readFileSync(".env.example", "utf8").split("\n")) {
    const match = /^#?\s*([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (match) assert.ok(known.has(match[1]), `.env.example sets unknown ${match[1]}`);
  }
});
