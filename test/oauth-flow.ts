/** Helpers for driving the built-in sign-in in tests: consent page and code exchange. */
import assert from "node:assert/strict";

/** Web client: no consent page, a code comes straight back. */
export const WEB_OAUTH = {
  client_id: "mcpencode-web",
  redirect_uri: "http://127.0.0.1:3000/callback",
  response_type: "code",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
};

/** consent_id on the consent page and the cookie that must come back with it. */
export async function readConsent(response: Response): Promise<{ consentId: string; cookie: string; html: string }> {
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Allow access\?/);
  const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(consentId, "consent page carries a consent id");
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = /mcpencode_consent=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(cookie, "consent page sets the consent cookie");
  return { consentId, cookie: `mcpencode_consent=${cookie}`, html };
}

/** Answer the consent page. Returns the redirect response. */
export async function answerConsent(
  base: string,
  consent: { consentId: string; cookie: string },
  decision: "allow" | "deny" = "allow",
): Promise<Response> {
  return fetch(`${base}/id/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: consent.cookie },
    body: new URLSearchParams({ consent_id: consent.consentId, decision }),
    redirect: "manual",
  });
}

/** Sign in through the authorize form, allow on the consent page, and return the code. */
export async function signInForCode(
  base: string,
  params: Record<string, string>,
  username: string,
  password: string,
): Promise<string> {
  const authorize = await fetch(`${base}/id/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, username, password }),
    redirect: "manual",
  });
  const allowed = await answerConsent(base, await readConsent(authorize));
  assert.equal(allowed.status, 302);
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code);
  return code;
}

/** Register a client the way an MCP client does. */
export async function registerClient(
  base: string,
  redirectUris: string[],
  clientName = "Test client",
): Promise<Response> {
  return fetch(`${base}/id/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: "none" }),
  });
}

/** Register an MCP client for these callbacks and return its client id. */
export async function registeredClientId(base: string, redirectUris: string[]): Promise<string> {
  const res = await registerClient(base, redirectUris);
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}
