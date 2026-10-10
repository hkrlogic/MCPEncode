/**
 * OAuth return addresses (redirect_uri).
 *
 * MCP clients each come back to their own address (Cursor, Perplexity, the
 * kiosk, the next one). Keeping a hand-written list meant every new client
 * failed until someone edited this file. Any absolute callback is accepted
 * for those clients.
 *
 * The publisher's own browser sign-in stays on this app's /callback only.
 * The code is still single-use, bound to the exact address at the token
 * endpoint, and useless without the PKCE verifier. PKCE does not stop someone
 * who starts the sign-in themselves, so the sign-in page shows where the person
 * will be sent (callbackLabel), and an operator can pin remote web callbacks to
 * known hostnames with OAUTH_REDIRECT_HOSTS.
 */

const BLOCKED_SCHEMES = new Set(["javascript", "data", "file", "blob", "vbscript", "about"]);

export type CallbackCheck = {
  clientId: string;
  webClientId: string;
  publicBaseUrl: string;
  /**
   * Optional operator allowlist (OAUTH_REDIRECT_HOSTS). When set, an http(s)
   * callback must go to one of these hostnames. Loopback callbacks (desktop
   * apps) and app-scheme callbacks (cursor://) are not affected.
   */
  allowedHosts?: string[];
};

/** True when this client may be sent back to uri after sign-in. */
export function isAllowedCallback(uri: string, check: CallbackCheck): boolean {
  if (!safeCallback(uri)) return false;
  if (check.clientId === check.webClientId) {
    return uri === publisherCallback(check.publicBaseUrl);
  }
  return hostAllowed(uri, check.allowedHosts);
}

/** With no allowlist, any callback passes. With one, remote web callbacks must be on it. */
function hostAllowed(uri: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const parsed = new URL(uri);
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  return allowedHosts.includes(host);
}

/** Address shown on the sign-in page so the return site is visible before the password. */
export function callbackLabel(uri: string): string {
  const parsed = new URL(uri);
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return `${parsed.origin}${parsed.pathname}`;
  }
  const host = parsed.host ? `//${parsed.host}` : "";
  return `${parsed.protocol}${host}${parsed.pathname}`;
}

function publisherCallback(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/callback`;
}

function safeCallback(uri: string): boolean {
  if (!uri || uri.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!scheme || BLOCKED_SCHEMES.has(scheme)) return false;
  if ((scheme === "http" || scheme === "https") && !parsed.hostname) return false;
  return true;
}
