/** Error page for sign-in and publisher failures. */
import { esc, layout } from "./layout.ts";

export function errorPage(message: string): string {
  return layout({
    title: "Error · MCPEncode",
    body: `<p class="error">${esc(message)}</p><p><a href="/">Library</a></p>`,
  });
}

/** GET /logout: a confirm form. Signing out is a POST with the CSRF token. */
export function signOutPage(csrf: string): string {
  return layout({
    title: "Sign out · MCPEncode",
    csrf,
    body: `<form class="capture" method="post" action="/logout">
      <h1>Sign out?</h1>
      <p class="hint">This signs out every browser and MCP client using this account.</p>
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <p><button class="btn" type="submit">Sign out</button> <a class="btn secondary" href="/">Cancel</a></p>
    </form>`,
  });
}
