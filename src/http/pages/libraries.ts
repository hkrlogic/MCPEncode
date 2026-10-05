/** Library list and single-library item lists. */
import { can, type Access } from "../../auth/rbac.ts";
import type { LibraryAccessRow } from "../../db/access.ts";
import type { ItemSummary, LibraryRow } from "../../db/models.ts";
import type { TableProposal } from "../../items/table-proposal.ts";
import { esc, itemListMarkup, kindKicker, layout, type AppShell } from "./layout.ts";

export function librariesPage(input: {
  access: Access;
  csrf: string;
  libraries: { id: string; name: string; template: string; access_role: string }[];
  orphans?: { id: string; name: string; template: string }[];
  error?: string;
}): string {
  const shell: AppShell = {
    libraries: input.libraries,
    orphans: input.orphans,
    csrf: input.csrf,
    canAddLibrary: can(input.access, "records.write"),
    addError: input.error,
  };

  const empty =
    input.libraries.length === 0 && (!input.orphans || input.orphans.length === 0)
      ? `<p class="empty-pane-lead">Add a library in the left pane to get started.</p>`
      : `<p class="empty-pane-lead">Open a library from the left pane to work with its items.</p>`;

  return layout({
    title: "Libraries · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="empty-pane">
        <h1>Libraries</h1>
        ${empty}
        <p class="hint">Each library has its own items, access list, and MCP link.</p>
      </div>
    `,
  });
}

function libraryKicker(library: LibraryRow): string {
  if (library.template === "table" && library.schema.tableName) {
    return `<p class="kicker">${esc(`Table · ${library.schema.tableName}`)}</p>`;
  }
  return kindKicker(library.template);
}

function columnTypeLabel(type: TableProposal["columns"][number]["type"]): string {
  if (type === "date") return "Date";
  if (type === "longtext") return "Long text";
  return "Text";
}

/** Publishers only. Readers and the kiosk never receive this block. */
function tableProposalPanel(input: {
  library: LibraryRow;
  csrf: string;
  itemCount: number;
}): string {
  const proposal = input.library.tableProposal;
  if (!proposal && !input.library.tableProposalUnreadable) return "";
  if (!proposal) {
    return `
      <section class="table-proposal" aria-labelledby="table-proposal-heading">
        <h2 id="table-proposal-heading">Table waiting for approval</h2>
        <p class="error" role="alert">A table proposal is stored but could not be read. Reject it, then propose again.</p>
        <form method="post" action="/libraries/${esc(input.library.id)}/table/reject">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <button class="btn secondary" type="submit">Reject</button>
        </form>
      </section>`;
  }
  const columns = proposal.columns
    .map(
      (column) => `<tr>
        <td>${esc(column.label)}</td>
        <td>${esc(columnTypeLabel(column.type))}</td>
        <td>${column.required ? "Required" : "Optional"}</td>
      </tr>`,
    )
    .join("");
  const sample =
    proposal.sampleRows.length === 0
      ? ""
      : `<h3>Sample rows</h3>
        <p class="hint">Examples for review. Approving does not add them as items.</p>
        <table class="proposal-rows">
          <thead><tr>${proposal.columns.map((column) => `<th>${esc(column.label)}</th>`).join("")}</tr></thead>
          <tbody>
            ${proposal.sampleRows
              .map(
                (row) =>
                  `<tr>${proposal.columns.map((column) => `<td>${esc(row[column.key] ?? "")}</td>`).join("")}</tr>`,
              )
              .join("")}
          </tbody>
        </table>`;
  const blocked = input.itemCount > 0;
  const when = proposal.proposedAt
    ? new Date(proposal.proposedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "";
  return `
    <section class="table-proposal" aria-labelledby="table-proposal-heading">
      <h2 id="table-proposal-heading">Table waiting for approval</h2>
      <p class="hint">An agent proposed this table. Readers and the kiosk cannot see it. Approving makes these columns the fields for items in this library. That can happen only while the library has no items.</p>
      <p class="proposal-name"><strong>${esc(proposal.name)}</strong></p>
      ${proposal.proposedBy ? `<p class="hint">Proposed by <code>${esc(proposal.proposedBy)}</code>${when ? ` · ${esc(when)}` : ""}</p>` : ""}
      <table class="proposal-columns">
        <thead><tr><th>Column</th><th>Type</th><th></th></tr></thead>
        <tbody>${columns}</tbody>
      </table>
      ${sample}
      ${
        blocked
          ? `<p class="error" role="alert">This library already has items, so Approve is unavailable. Reject this proposal, or approve a table on an empty library.</p>`
          : ""
      }
      <div class="proposal-actions">
        ${
          blocked
            ? ""
            : `<form method="post" action="/libraries/${esc(input.library.id)}/table/approve">
                <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                <button class="btn" type="submit">Approve</button>
              </form>`
        }
        <form method="post" action="/libraries/${esc(input.library.id)}/table/reject">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <button class="btn secondary" type="submit">Reject</button>
        </form>
      </div>
    </section>`;
}

function accessPanel(input: {
  library: LibraryRow;
  csrf: string;
  accessList: LibraryAccessRow[];
  viewerSub: string;
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
      <h2 id="access-heading" class="sr-only">Access</h2>
      <p class="hint">Grant by IdP subject (<code>sub</code>). Your subject is <code>${esc(input.viewerSub)}</code>.</p>
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

/** Publisher sections. Opening a library starts on the published item list. */
type LibraryTab = "items" | "pending" | "archives" | "access";

/** Tab links keep the current search so switching sections does not drop it. */
function libraryTabHref(libraryId: string, tab: LibraryTab, q?: string): string {
  const params = new URLSearchParams();
  if (tab !== "items") params.set("tab", tab);
  if (q) params.set("q", q);
  const query = params.toString();
  const path = `/libraries/${encodeURIComponent(libraryId)}`;
  return esc(query ? `${path}?${query}` : path);
}

function tabBadge(count: number, tone: "pending" | "archive"): string {
  if (count <= 0) return "";
  return `<span class="tab-count tab-count-${tone}">${count}</span>`;
}

export function libraryPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  items: ItemSummary[];
  error?: string;
  q?: string;
  /** Publisher section. Readers always see published items. */
  tab?: LibraryTab;
  mcpUrl: string;
  accessList?: LibraryAccessRow[];
  viewerSub?: string;
  orphan?: boolean;
  /** Flash after bulk Publish, e.g. "3". */
  publishedCount?: string;
  /** Fixed notice after Approve or Reject. Not raw query text. */
  notice?: string;
  /** Item count used to explain why Approve is unavailable. */
  itemCount?: number;
  /** Libraries for the left pane. */
  shellLibraries: AppShell["libraries"];
  shellOrphans?: AppShell["orphans"];
}): string {
  const shell: AppShell = {
    libraries: input.shellLibraries,
    orphans: input.shellOrphans,
    activeLibraryId: input.library.id,
    csrf: input.csrf,
    canAddLibrary: can(input.access, "records.write"),
  };

  if (input.orphan) {
    return layout({
      title: `${input.library.name} · MCPEncode`,
      csrf: input.csrf,
      access: input.access,
      library: input.library,
      shell,
      body: `
        <div class="library-view">
          <header class="library-head">
            <div>
              ${libraryKicker(input.library)}
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
  const requested = input.tab ?? "items";
  // Readers only receive published items, so the other sections stay closed.
  const tab: LibraryTab =
    canWrite && (requested === "pending" || requested === "archives" || requested === "access")
      ? requested
      : "items";
  const bulkNotice =
    input.publishedCount && Number(input.publishedCount) > 0
      ? `<p class="notice" role="status">${esc(
          Number(input.publishedCount) === 1
            ? "1 item published. It is live for readers and the kiosk."
            : `${input.publishedCount} items published. They are live for readers and the kiosk.`,
        )}</p>`
      : "";

  const itemsPanel = `
    <section class="library-items" aria-labelledby="items-heading">
      <h2 id="items-heading" class="sr-only">Items</h2>
      ${itemListMarkup(
        canWrite ? published : input.items,
        input.library.id,
        input.q ? emptySearch : "No published items yet.",
        false,
      )}
    </section>`;

  const pendingPanel =
    pending.length === 0
      ? `
        <section class="library-items" aria-labelledby="pending-heading">
          <h2 id="pending-heading" class="sr-only">Pending</h2>
          <p class="hint library-tab-hint">Drafts waiting to be published. Not visible to the kiosk.</p>
          ${itemListMarkup([], input.library.id, input.q ? emptySearch : "Nothing pending.", false)}
        </section>`
      : `
        <section class="library-items" aria-labelledby="pending-heading">
          <h2 id="pending-heading" class="sr-only">Pending</h2>
          <form method="post" action="/libraries/${esc(input.library.id)}/items/publish" class="pending-publish" id="pending-publish">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <p class="hint library-tab-hint">Drafts waiting to be published. Not visible to the kiosk. Select items and Publish when ready.</p>
            <div class="pending-toolbar">
              <label class="pending-select-all">
                <input type="checkbox" id="pending-select-all">
                <span>Select all</span>
              </label>
              <button class="btn" type="submit" id="pending-publish-btn" disabled>Publish selected</button>
            </div>
            ${itemListMarkup(pending, input.library.id, input.q ? emptySearch : "Nothing pending.", false, {
              selectable: true,
            })}
          </form>
        </section>`;

  const archivesPanel = `
    <section class="library-items" aria-labelledby="archives-heading">
      <h2 id="archives-heading" class="sr-only">Archives</h2>
      <p class="hint library-tab-hint">Hidden from the kiosk and from Pending.</p>
      ${itemListMarkup(archived, input.library.id, input.q ? emptySearch : "No archived items.", false)}
    </section>`;

  const accessBlock =
    canWrite && input.accessList && input.viewerSub
      ? accessPanel({
          library: input.library,
          csrf: input.csrf,
          accessList: input.accessList,
          viewerSub: input.viewerSub,
        })
      : `<p class="empty">Access is managed by a publisher on this library.</p>`;

  const panel =
    tab === "pending" ? pendingPanel : tab === "archives" ? archivesPanel : tab === "access" ? accessBlock : itemsPanel;

  const tabs = canWrite
    ? `<nav class="library-tabs" aria-label="Library">
        <a href="${libraryTabHref(input.library.id, "items", input.q)}"${tab === "items" ? ' aria-current="page"' : ""}>Items</a>
        <a href="${libraryTabHref(input.library.id, "pending", input.q)}"${tab === "pending" ? ' aria-current="page"' : ""}>Pending${tabBadge(pending.length, "pending")}</a>
        <a href="${libraryTabHref(input.library.id, "archives", input.q)}"${tab === "archives" ? ' aria-current="page"' : ""}>Archives${tabBadge(archived.length, "archive")}</a>
        <a href="${libraryTabHref(input.library.id, "access", input.q)}"${tab === "access" ? ' aria-current="page"' : ""}>Access</a>
      </nav>`
    : "";

  const search =
    tab === "access"
      ? ""
      : `<form method="get" action="/libraries/${esc(input.library.id)}" class="search" role="search">
          ${tab === "items" ? "" : `<input type="hidden" name="tab" value="${esc(tab)}">`}
          <label class="sr-only" for="q">Search items</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Search items" autocomplete="off">
          <button type="submit">Search</button>
        </form>`;

  // The link stays in the header so publishers can copy it without leaving the item list.
  const mcpBlock = `
    <details class="mcp-menu">
      <summary>MCP link</summary>
      <div class="mcp-panel">
        <p class="hint">Hand this link to Cursor or the kiosk for this library only. Sign-in is still required.</p>
        <p class="mcp-url"><code id="mcp-url">${esc(input.mcpUrl)}</code></p>
        <button type="button" class="btn secondary" data-copy="#mcp-url">Copy</button>
      </div>
    </details>`;

  return layout({
    title: `${input.library.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            ${libraryKicker(input.library)}
            <h1>${esc(input.library.name)}</h1>
          </div>
          <div class="head-actions">
            ${mcpBlock}
            ${addLink}
            ${deleteLibrary}
          </div>
        </header>
        ${input.notice ? `<p class="notice" role="status">${esc(input.notice)}</p>` : ""}
        ${bulkNotice}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        ${canWrite ? tableProposalPanel({ library: input.library, csrf: input.csrf, itemCount: input.itemCount ?? 0 }) : ""}
        ${tabs}
        ${search}
        ${panel}
      </div>
      <script>
        document.querySelectorAll("[data-copy]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const el = document.querySelector(btn.getAttribute("data-copy"));
            if (!el) return;
            try {
              await navigator.clipboard.writeText(el.textContent || "");
              const previous = btn.textContent;
              btn.textContent = "Copied";
              setTimeout(() => { btn.textContent = previous || "Copy"; }, 1500);
            } catch { /* clipboard can be denied; the link stays visible */ }
          });
        });
        (function mcpMenu() {
          const menu = document.querySelector(".mcp-menu");
          if (!menu) return;
          document.addEventListener("click", (event) => {
            if (!menu.open) return;
            if (event.target instanceof Node && menu.contains(event.target)) return;
            menu.open = false;
          });
          document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && menu.open) {
              menu.open = false;
              const summary = menu.querySelector("summary");
              if (summary instanceof HTMLElement) summary.focus();
            }
          });
        })();
        (function pendingSelect() {
          const form = document.getElementById("pending-publish");
          if (!form) return;
          const selectAll = document.getElementById("pending-select-all");
          const publishBtn = document.getElementById("pending-publish-btn");
          const boxes = () => Array.from(form.querySelectorAll('input[name="item_id"]'));
          function sync() {
            const all = boxes();
            const checked = all.filter((box) => box.checked);
            if (publishBtn) publishBtn.disabled = checked.length === 0;
            if (selectAll) {
              selectAll.checked = all.length > 0 && checked.length === all.length;
              selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
            }
          }
          selectAll?.addEventListener("change", () => {
            boxes().forEach((box) => { box.checked = selectAll.checked; });
            sync();
          });
          form.addEventListener("change", (event) => {
            const target = event.target;
            if (target instanceof HTMLInputElement && target.name === "item_id") sync();
          });
          sync();
        })();
      </script>
    `,
  });
}
