/**
 * npm run check-env [path]: validate a .env (default ./.env) without starting
 * the app or touching the database. Prints what is missing, ignored or unknown,
 * then runs the same checks as startup. Never prints secret values.
 * Exit code 0 when the app would start with this file, 1 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { loadConfig } from "../src/config.ts";
import { ALIAS_ENV_VARS, ENV_VARS, REMOVED_ENV_VARS } from "../src/env-schema.ts";

const path = process.argv[2] ?? ".env";
if (!existsSync(path)) {
  console.error(`${path} not found. Run scripts/init-env.sh to create it.`);
  process.exit(1);
}
const values = parse(readFileSync(path));
const known = new Set([...ENV_VARS.map((v) => v.name), ...ALIAS_ENV_VARS]);
let problems = 0;

const hasDbUrl = Boolean(values.DATABASE_URL?.trim());
for (const v of ENV_VARS) {
  const set = Boolean(values[v.name]?.trim());
  if (set) continue;
  if (v.required === "yes" && !(v.name === "POSTGRES_PASSWORD" && hasDbUrl)) {
    console.log(`missing   ${v.name}  (${v.description}) Run scripts/init-env.sh to fill it.`);
    problems += 1;
  }
  if (v.required === "oidc" && values.AUTH_MODE === "oidc") {
    console.log(`missing   ${v.name}  (required with AUTH_MODE=oidc, see docs/oidc.md)`);
    problems += 1;
  }
}
for (const name of Object.keys(values)) {
  if (REMOVED_ENV_VARS.includes(name)) console.log(`ignored   ${name}  (removed setting; delete the line)`);
  else if (!known.has(name)) console.log(`unknown   ${name}  (not read by the app; typo?)`);
}

// Same validation as startup, against this file only.
for (const v of [...ENV_VARS.map((e) => e.name), ...ALIAS_ENV_VARS, ...REMOVED_ENV_VARS]) delete process.env[v];
Object.assign(process.env, values);
try {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    loadConfig();
  } finally {
    console.warn = quiet;
  }
} catch (error) {
  console.log(`invalid   ${error instanceof Error ? error.message : String(error)}`);
  problems += 1;
}

if (problems === 0) {
  console.log(`ok        ${path} is valid (database reachability is not checked; see /healthz).`);
} else {
  process.exit(1);
}
