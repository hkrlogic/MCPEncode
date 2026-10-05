/** Landing / sign-in and error pages. */
import { esc, layout } from "./layout.ts";

export function loginPage(): string {
  return layout({
    title: "MCPEncode",
    body: `
      <div class="landing">
        <section class="landing-hero">
          <h1 class="landing-brand">MCPEncode</h1>
          <p class="landing-title">Library</p>
          <p class="landing-lead">Precise libraries of items you can publish for people and agents.</p>
          <div class="landing-cta">
            <a class="btn" href="/login">Sign in</a>
            <p class="landing-note">Edit drafts. Publish on purpose. Readers and the kiosk only see what you approve.</p>
          </div>
        </section>

        <section class="landing-path" aria-label="How it works">
          <ol class="landing-steps">
            <li class="landing-step">
              <span class="landing-step-label">Write</span>
              <p>Add items with a name, labels, summary, and body. Keep unfinished work in Pending.</p>
            </li>
            <li class="landing-step">
              <span class="landing-step-label">Publish</span>
              <p>Publish is an explicit step. Saving an edit moves a live item back to Pending until you approve again.</p>
            </li>
            <li class="landing-step">
              <span class="landing-step-label">Look up</span>
              <p>People and agents look up published items. If it is not in the library, they say so. Nothing is invented.</p>
            </li>
          </ol>
        </section>

        <section class="landing-proof" aria-labelledby="landing-proof-heading">
          <h2 id="landing-proof-heading">Built for answers you can trust</h2>
          <ul class="landing-points">
            <li>
              <strong>One library at a time</strong>
              <span>Policy, procedure, or free-form — each library keeps a clear shape.</span>
            </li>
            <li>
              <strong>Publish gate</strong>
              <span>Drafts stay off the kiosk until you publish. Edit is never a hot mic.</span>
            </li>
            <li>
              <strong>Cite or refuse</strong>
              <span>Lookups return the item or say it is not there. Agents must not guess.</span>
            </li>
          </ul>
        </section>

        <section class="landing-close">
          <p>Sign in to view or add libraries.</p>
          <a class="btn" href="/login">Sign in</a>
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
