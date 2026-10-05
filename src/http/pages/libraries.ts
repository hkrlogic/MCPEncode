/** Library list and single-library item lists. */
import { can, type Access } from "../../auth/rbac.ts";
import type { LibraryAccessRow } from "../../db/access.ts";
import type { ItemSummary, LibraryRow } from "../../db/models.ts";
import { esc, itemListMarkup, kindKicker, layout } from "./layout.ts";

export function librariesPage(input: {
  access: Access;
  csrf: string;
  libraries: { id: string; name: string; template: string; access_role: string }[];
  orphans?: { id: string; name: string; template: string }[];
  error?: string;
}): string {
  const form = can(input.access, "records.write")
    ? `
    <details class="add-panel"${input.error ? " open" : ""}>
      <summary class="btn">Add library</summary>
      <form method="post" action="/libraries" class="capture">
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <label>Name
          <input name="name" required maxlength="200" autocomplete="off" placeholder="Remote access">
        </label>
        <label>Type
          <select name="template">
            <option value="general">Free-form</option>
            <option value="policy">Policy</option>
            <option value="procedure">Procedure</option>
          </select>
        </label>
        <button class="btn" type="submit">Add library</button>
      </form>
    </details>`
    : "";

  const list =
    input.libraries.length === 0
      ? `<p class="empty">No libraries you can open yet.</p>`
      : `<ul class="cards">
          ${input.libraries
            .map(
              (row) => `
            <li>
              <a href="/libraries/${esc(row.id)}">
                ${kindKicker(row.template as LibraryRow["template"])}
                <h2>${esc(row.name)}</h2>
                <p class="meta">${row.access_role === "publisher" ? "Publisher" : "Reader"}</p>
              </a>
            </li>`,
            )
            .join("")}
        </ul>`;

  const orphans =
    input.orphans && input.orphans.length > 0
      ? `
      <section class="library-items" aria-labelledby="orphan-heading">
        <h2 id="orphan-heading">Unclaimed libraries</h2>
        <p class="hint">These have no access list yet. Claim one to become its publisher.</p>
        <ul class="cards">
          ${input.orphans
            .map(
              (row) => `
            <li>
              <a href="/libraries/${esc(row.id)}">
                ${kindKicker(row.template as LibraryRow["template"])}
                <h2>${esc(row.name)}</h2>
              </a>
            </li>`,
            )
            .join("")}
        </ul>
      </section>`
      : "";

  return layout({
    title: "Library · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    body: `
      <div class="library-view">
        <header class="library-head">
          <h1>Library</h1>
          ${form}
        </header>
        ${list}
        ${orphans}
      </div>
    `,
  });
}

function accessPanel(input: {
  library: LibraryRow;
  csrf: string;
  accessList: LibraryAccessRow[];
  viewerSub: string;
  error?: string;
}): string {
  const rows =
    input.accessList.length === 0
      ? `<p class="empty">No one on the access list yet.</p>`
      : `<ul class="access-list">
          ${input.accessList
            .map(
              (row) => `
            <li>
              <span class="access-sub"><code>${esc(row.subject)}</code></span>
              <span class="access-role">${row.role === "publisher" ? "Publisher" : "Reader"}</span>
              <form method="post" action="/libraries/${esc(input.library.id)}/access/revoke" class="inline">
                <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                <input type="hidden" name="subject" value="${esc(row.subject)}">
                <button type="submit" class="linkish"${row.subject === input.viewerSub && row.role === "publisher" ? " title=\"You can remove yourself only when another publisher remains\"" : ""}>Remove</button>
              </form>
            </li>`,
            )
            .join("")}
        </ul>`;

  return `
    <section class="library-access" aria-labelledby="access-heading">
      <h2 id="access-heading">Access</h2>
      <p class="hint">Grant by IdP subject (<code>sub</code>). Your subject is <code>${esc(input.viewerSub)}</code>.</p>
      ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
      ${rows}
      <form method="post" action="/libraries/${esc(input.library.id)}/access" class="capture">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <label>Subject
          <input name="subject" required maxlength="255" autocomplete="off" placeholder="IdP sub">
        </label>
        <label>Role
          <select name="role">
            <option value="reader">Reader</option>
            <option value="publisher">Publisher</option>
          </select>
        </label>
        <button class="btn" type="submit">Grant access</button>
      </form>
    </section>`;
}

export function libraryPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  items: ItemSummary[];
  error?: string;
  q?: string;
  mcpUrl: string;
  accessList?: LibraryAccessRow[];
  viewerSub?: string;
  orphan?: boolean;
}): string {
  if (input.orphan) {
    return layout({
      title: `${input.library.name} · MCPEncode`,
      csrf: input.csrf,
      access: input.access,
      library: input.library,
      body: `
        <div class="library-view">
          <header class="library-head">
            <div>
              ${kindKicker(input.library.template)}
              <h1>${esc(input.library.name)}</h1>
            </div>
          </header>
          <p>This library has no access list yet.</p>
          <form method="post" action="/libraries/${esc(input.library.id)}/claim">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <button class="btn" type="submit">Claim as publisher</button>
          </form>
        </div>
      `,
    });
  }

  const canWrite = can(input.access, "records.write");
  const addLink = canWrite
    ? `<a class="btn" href="/libraries/${esc(input.library.id)}/items/new">Add item</a>`
    : "";
  const deleteLibrary = can(input.access, "records.delete")
    ? `<details class="item-menu">
         <summary>Actions</summary>
         <div class="menu-list">
           <form method="post" action="/libraries/${esc(input.library.id)}/delete"
                onsubmit="return confirm('Delete this library and every item in it?');">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <button class="menu-danger" type="submit">Delete library</button>
           </form>
         </div>
       </details>`
    : "";

  const published = input.items.filter((row) => row.status === "published");
  const pending = input.items.filter((row) => row.status === "draft");
  const archived = input.items.filter((row) => row.status === "archived");
  const emptySearch = input.q ? "No items match that search." : "No items yet.";

  const lists = canWrite
    ? `
        <section class="library-items" aria-labelledby="pending-heading">
          <div class="section-row">
            <h2 id="pending-heading">Pending</h2>
            <p class="count">${pending.length === 1 ? "1 item" : `${pending.length} items`}</p>
          </div>
          <p class="hint">Drafts waiting to be published. Not visible to the kiosk.</p>
          ${itemListMarkup(pending, input.library.id, input.q ? emptySearch : "Nothing pending.", true)}
        </section>
        <section class="library-items" aria-labelledby="published-heading">
          <div class="section-row">
            <h2 id="published-heading">Published</h2>
            <p class="count">${published.length === 1 ? "1 item" : `${published.length} items`}</p>
          </div>
          <p class="hint">Live for readers and the kiosk.</p>
          ${itemListMarkup(published, input.library.id, input.q ? emptySearch : "No published items yet.", true)}
        </section>
        <section class="library-items library-archived" aria-labelledby="archived-heading">
          <details>
            <summary>
              <span id="archived-heading">Archived</span>
              <span class="count">${archived.length === 1 ? "1 item" : `${archived.length} items`}</span>
            </summary>
            ${itemListMarkup(archived, input.library.id, input.q ? emptySearch : "No archived items.", true)}
          </details>
        </section>`
    : `
        <section class="library-items" aria-labelledby="items-heading">
          <div class="section-row">
            <h2 id="items-heading" class="sr-only">Items</h2>
            <p class="count">${input.items.length === 1 ? "1 item" : `${input.items.length} items`}</p>
          </div>
          ${itemListMarkup(input.items, input.library.id, emptySearch, false)}
        </section>`;

  const mcpBlock = `
    <section class="library-mcp" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">MCP link</h2>
      <p class="hint">Hand this link to Cursor or the kiosk for this library only. Sign-in still required; access list still applies.</p>
      <p class="mcp-url"><code id="mcp-url">${esc(input.mcpUrl)}</code>
        <button type="button" class="btn" data-copy="#mcp-url">Copy</button>
      </p>
    </section>`;

  const accessBlock =
    canWrite && input.accessList && input.viewerSub
      ? accessPanel({
          library: input.library,
          csrf: input.csrf,
          accessList: input.accessList,
          viewerSub: input.viewerSub,
          error: input.error,
        })
      : input.error
        ? `<p class="error" role="alert">${esc(input.error)}</p>`
        : "";

  return layout({
    title: `${input.library.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            ${kindKicker(input.library.template)}
            <h1>${esc(input.library.name)}</h1>
          </div>
          <div class="head-actions">
            ${addLink}
            ${deleteLibrary}
          </div>
        </header>
        ${mcpBlock}
        <form method="get" action="/libraries/${esc(input.library.id)}" class="search" role="search">
          <label class="sr-only" for="q">Search items</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Search items" autocomplete="off" autofocus>
          <button type="submit">Search</button>
        </form>
        ${lists}
        ${accessBlock}
      </div>
      <script>
        document.querySelectorAll("[data-copy]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const el = document.querySelector(btn.getAttribute("data-copy"));
            if (!el) return;
            try {
              await navigator.clipboard.writeText(el.textContent || "");
              btn.textContent = "Copied";
              setTimeout(() => { btn.textContent = "Copy"; }, 1500);
            } catch { /* ignore */ }
          });
        });
      </script>
    `,
  });
}
