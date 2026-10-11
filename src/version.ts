import { readFileSync } from "node:fs";

/**
 * The app version from package.json, so MCP clients see the same number as npm.
 * Read once at startup. The Docker image copies package.json next to src/.
 */
export const APP_VERSION: string = (() => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || !version) {
    throw new Error("package.json has no version");
  }
  return version;
})();
