/** Error page for sign-in and publisher failures. */
import { esc, layout } from "./layout.ts";

export function errorPage(message: string): string {
  return layout({
    title: "Error · MCPEncode",
    body: `<p class="error">${esc(message)}</p><p><a href="/">Library</a></p>`,
  });
}
