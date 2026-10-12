/**
 * OAuth return addresses (redirect_uri).
 *
 * A sign-in code goes to the callback the client registered, so the callback
 * decides who receives it. By default only callbacks that stay on the person's
 * own machine are accepted (RFC 8252, OAuth for native apps):
 *
 * - loopback http(s): http://127.0.0.1:<port>/..., http://[::1]:<port>/...,
 *   http://localhost:<port>/... (Claude Code, MCP Inspector, mcp-remote, VS Code)
 * - private-use schemes (RFC 8252 section 7.1): a reverse-DNS scheme with a
 *   dot, such as com.example.app:/callback, or one of the known single-word
 *   client schemes (cursor, vscode, vscode-insiders, claude). Browser launchers (microsoft-edge:, x-safari-https:,
 *   googlechromes:, firefox:, ...) and OS handlers (ms-*, search-ms:, shell:)
 *   are refused: they would open a web page at an address the client chose,
 *   carrying the code. A custom callback whose path holds another URL
 *   (foo:https://evil.example/) is refused for the same reason.
 *
 * A remote https callback (a hosted client such as claude.ai) must be on the
 * operator's OAUTH_REDIRECT_HOSTS list. Plain http to a remote
 * host is never accepted.
 *
 * The publisher's own browser sign-in stays on this app's /callback only.
 */

const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "blob",
  "vbscript",
  "about",
  "ws",
  "wss",
  "ftp",
  "mailto",
  "tel",
  "sms",
  "intent",
]);

/** Single-word app schemes accepted without a dot. */
export const DEFAULT_ALLOWED_SCHEMES = ["cursor", "vscode", "vscode-insiders", "claude"];

/**
 * Schemes that hand the address to a browser or the OS shell. Refused even when
 * written with a dot.
 */
const LAUNCHER_SCHEMES = new Set([
  "microsoft-edge",
  "microsoft-edge-holographic",
  "googlechrome",
  "googlechromes",
  "firefox",
  "firefox-private",
  "brave",
  "opera",
  "operas",
  "opera-http",
  "opera-https",
  "vivaldi",
  "duckduckgo",
  "search-ms",
  "search",
  "shell",
  "explorer",
  "res",
  "its",
  "mk",
  "jar",
  "view-source",
  "chrome",
  "chrome-extension",
  "moz-extension",
  "edge",
  "read",
  "http+unix",
]);

/** Scheme prefixes that belong to browsers or OS handlers. */
const LAUNCHER_PREFIXES = ["x-safari-", "ms-", "opera", "googlechrome", "microsoft-", "firefox", "brave", "chrome-", "edge-"];

/** True for a browser-launcher or OS-handler scheme. */
export function isLauncherScheme(scheme: string): boolean {
  const lower = scheme.toLowerCase();
  if (BLOCKED_SCHEMES.has(lower) || LAUNCHER_SCHEMES.has(lower)) return true;
  return LAUNCHER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export type CallbackCheck = {
  clientId: string;
  webClientId: string;
  publicBaseUrl: string;
  /** OAUTH_REDIRECT_HOSTS: remote https hostnames an MCP client may return to. */
  allowedHosts?: string[];
  /** Single-word app schemes to accept. Defaults to DEFAULT_ALLOWED_SCHEMES. */
  allowedSchemes?: readonly string[];
};

export type CallbackKind = "loopback" | "custom-scheme" | "listed-host";

/** Loopback names a desktop client listens on. */
export function isLoopbackCallbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Why a callback is acceptable under the redirect policy, or undefined when it
 * is not. Does not know about registrations; see redirectMatches for that.
 */
export function callbackKind(uri: string, check: Omit<CallbackCheck, "clientId" | "webClientId" | "publicBaseUrl">): CallbackKind | undefined {
  const parsed = safeCallback(uri);
  if (!parsed) return undefined;
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return customSchemeAllowed(parsed, scheme, check.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES) ? "custom-scheme" : undefined;
  }
  if (isLoopbackCallbackHost(parsed.hostname)) return "loopback";
  if (scheme !== "https") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (check.allowedHosts?.includes(host)) return "listed-host";
  return undefined;
}

function customSchemeAllowed(parsed: URL, scheme: string, allowedSchemes: readonly string[]): boolean {
  if (isLauncherScheme(scheme)) return false;
  if (!scheme.includes(".") && !allowedSchemes.includes(scheme)) return false;
  // microsoft-edge:https://evil/ style: another URL tucked into the path.
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (path.includes("://")) return false;
  return true;
}

/** True when this client may be sent back to uri after sign-in, under the redirect policy. */
export function isAllowedCallback(uri: string, check: CallbackCheck): boolean {
  if (!safeCallback(uri)) return false;
  if (check.clientId === check.webClientId) {
    return uri === publisherCallback(check.publicBaseUrl);
  }
  return callbackKind(uri, check) !== undefined;
}

/**
 * True when the redirect_uri on an authorize request is one the client
 * registered. The match is exact, with one exception from RFC 8252 section
 * 7.3: a loopback IP callback may use a different port, because a desktop
 * client picks a free port each time it listens. Scheme, host, path and query
 * must still match.
 */
export function redirectMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  const asked = safeCallback(requested);
  if (!asked || !isLoopbackIp(asked.hostname)) return false;
  return registered.some((entry) => {
    const known = safeCallback(entry);
    if (!known || !isLoopbackIp(known.hostname)) return false;
    return (
      known.protocol === asked.protocol &&
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}

/** 127.0.0.1 and [::1] only. RFC 8252 does not extend the port rule to the name localhost. */
function isLoopbackIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1";
}

/** Full callback address shown on the sign-in and consent pages, so nothing about the return site is hidden. */
export function callbackLabel(uri: string): string {
  return new URL(uri).toString();
}

/** The host (or scheme, for an app callback) a code is sent to. Shown on the consent page. */
export function callbackHost(uri: string): string {
  const parsed = new URL(uri);
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https") return parsed.host;
  return parsed.host ? `${scheme}://${parsed.host}` : `${scheme}:`;
}

function publisherCallback(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/callback`;
}

function safeCallback(uri: string): URL | undefined {
  if (!uri || uri.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.hash) return undefined;
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!scheme || BLOCKED_SCHEMES.has(scheme)) return undefined;
  if ((scheme === "http" || scheme === "https") && !parsed.hostname) return undefined;
  return parsed;
}
