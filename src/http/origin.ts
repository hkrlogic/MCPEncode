/**
 * Browser Origin checks for the publisher.
 * A missing Origin is a non-browser client and is allowed.
 * The literal value "null" is what browsers send on the redirect after the
 * sign-in form. That is a page navigation, not another site calling the app.
 */

export function originAllowed(input: {
  origin: string | undefined;
  method: string;
  secFetchMode: string | undefined;
  secFetchSite?: string | undefined;
  allowedHostnames: readonly string[];
}): { ok: true } | { ok: false; message: string } {
  const origin = input.origin;
  if (origin === undefined || origin === "") return { ok: true };

  if (origin === "null") {
    const method = input.method.toUpperCase();
    const mode = input.secFetchMode;
    const site = input.secFetchSite;
    // Browsers send Origin: null on this app's own sign-in form and on the
    // redirect that follows it. Another site cannot set Sec-Fetch-Site.
    if (site === "same-origin" || site === "none") return { ok: true };
    if ((method === "GET" || method === "HEAD") && (mode === undefined || mode === "" || mode === "navigate")) {
      return { ok: true };
    }
    return { ok: false, message: "Invalid Origin header: null" };
  }

  let hostname = "";
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return { ok: false, message: `Invalid Origin header: ${origin}` };
  }
  if (!hostname || !input.allowedHostnames.includes(hostname)) {
    return {
      ok: false,
      message: hostname ? `Invalid Origin: ${hostname}` : `Invalid Origin header: ${origin}`,
    };
  }
  return { ok: true };
}
