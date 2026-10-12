/**
 * OAuth return addresses (redirect_uri).
 *
 * A sign-in code goes to the callback the client registered, so the callback
 * decides who receives it. By default only callbacks that stay on the person's
 * own machine are accepted (RFC 8252, OAuth for native apps):
 *
 * - loopback http(s): http://127.0.0.1:<port>/..., http://[::1]:<port>/...,
 *   http://localhost:<port>/... (Claude Code, MCP Inspector, mcp-remote, VS Code)
 * - private-use or custom schemes: cursor://..., com.example.app:/...
 *
 * A remote https callback (a hosted client such as claude.ai) must be on the
 * operator's OAUTH_REDIRECT_HOSTS list, or the operator must opt in to any
 * https host with OAUTH_ALLOW_ANY_HTTPS_REDIRECT=true. Plain http to a remote
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

export type CallbackCheck = {
  clientId: string;
  webClientId: string;
  publicBaseUrl: string;
  /** OAUTH_REDIRECT_HOSTS: remote https hostnames an MCP client may return to. */
  allowedHosts?: string[];
  /** OAUTH_ALLOW_ANY_HTTPS_REDIRECT: accept any https host. Off by default. */
  allowAnyHttps?: boolean;
};

export type CallbackKind = "loopback" | "custom-scheme" | "listed-host" | "any-https";

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
  if (scheme !== "http" && scheme !== "https") return "custom-scheme";
  if (isLoopbackCallbackHost(parsed.hostname)) return "loopback";
  if (scheme !== "https") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (check.allowedHosts?.includes(host)) return "listed-host";
  if (check.allowAnyHttps === true) return "any-https";
  return undefined;
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

/** Address shown on the sign-in and consent pages so the return site is visible. */
export function callbackLabel(uri: string): string {
  const parsed = new URL(uri);
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return `${parsed.origin}${parsed.pathname}`;
  }
  const host = parsed.host ? `//${parsed.host}` : "";
  return `${parsed.protocol}${host}${parsed.pathname}`;
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
