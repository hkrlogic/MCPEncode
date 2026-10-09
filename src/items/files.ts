/**
 * Files on an item. PDF and images only, sniffed from the bytes — not the
 * browser's claimed type. Caps match what a policy PDF or a screenshot needs.
 */

/** 10 MB. A policy PDF or a screenshot fits; video and slide decks do not. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Five files on one item. */
export const MAX_FILES_PER_ITEM = 5;

export const FILE_CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;

export type FileContentType = (typeof FILE_CONTENT_TYPES)[number];

const EXTENSION: Record<FileContentType, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export function fileKindLabel(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === "image/png") return "PNG";
  if (contentType === "image/jpeg") return "JPEG";
  if (contentType === "image/webp") return "WebP";
  return "File";
}

/** Short size for the item page and for Connect. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * Identify a PDF or image from its leading bytes.
 * HTML, SVG, and other types return undefined so they are never stored.
 */
export function sniffFileType(bytes: Buffer): FileContentType | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Display name for download. Drops any path, and forces the sniffed extension
 * so a stored name cannot claim to be HTML.
 */
export function sanitizeFileName(raw: string, contentType: FileContentType): string {
  const ext = EXTENSION[contentType];
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  const stem = cleaned.replace(/\.[^.]+$/, "").replace(/\.+$/, "").trim();
  const safeStem = stem.length > 0 ? stem : "file";
  return `${safeStem.slice(0, 180)}${ext}`.slice(0, 200);
}
