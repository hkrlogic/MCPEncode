/** Landing / sign-in and error pages. */
import { esc, layout } from "./layout.ts";

export function loginPage(): string {
  return layout({
    title: "MCPEncode",
    body: `
      <div class="landing">
        <section class="landing-hero">
          <h1 class="landing-brand">MCPEncode</h1>
          <p class="landing-equation" aria-label="People plus agents equals ready">
            <span class="landing-equation-part" aria-hidden="true">👤</span>
            <span class="landing-equation-op" aria-hidden="true">+</span>
            <span class="landing-equation-part" aria-hidden="true">🤖</span>
            <span class="landing-equation-op" aria-hidden="true">=</span>
            <span class="landing-equation-ok" aria-hidden="true">✅</span>
          </p>
          <p class="landing-lead">Libraries of items you publish for people and agents.</p>
          <p class="landing-note">Add items — Publish — Look up</p>
        </section>
      </div>
    `,
  });
}

export function errorPage(message: string): string {
  return layout({
    title: "Error · MCPEncode",
    body: `<p class="error">${esc(message)}</p><p><a href="/">Library</a></p>`,
  });
}
