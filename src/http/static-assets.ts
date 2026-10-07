/**
 * Fingerprinted URLs for files under /public so browsers and Cloudflare
 * do not keep serving yesterday’s CSS after a deploy.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

const hashes = new Map<string, string>();

function fileHash(name: string): string {
  const cached = hashes.get(name);
  if (cached) return cached;
  const bytes = readFileSync(path.join(publicDir, name));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  hashes.set(name, hash);
  return hash;
}

/** Absolute path for Express `express.static`. */
export function staticPublicDir(): string {
  return publicDir;
}

/** Browser URL with a content hash query, e.g. `/static/styles.css?v=a1b2c3d4e5`. */
export function staticUrl(name: string): string {
  return `/static/${name}?v=${fileHash(name)}`;
}
