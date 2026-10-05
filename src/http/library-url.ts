/** Stable per-library MCP resource URL (token audience). */

const LIBRARY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLibraryId(value: string): boolean {
  return LIBRARY_ID.test(value);
}

/** MCP address for one library. This is the OAuth resource / audience. */
export function libraryMcpUrl(publicBaseUrl: string, libraryId: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/libraries/${libraryId}/mcp`;
}
