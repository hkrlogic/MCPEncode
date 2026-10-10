/** Library list and single-library item lists. */
import type { Account } from "../../auth/accounts.ts";
import { can, type Access } from "../../auth/rbac.ts";
import type { LibraryAccessRow } from "../../db/access.ts";
import type { ItemSummary, LibraryRow } from "../../db/models.ts";
import type { TableProposal } from "../../items/table-proposal.ts";
import {
  actionsMenuSummary,
  esc,
  itemListMarkup,
  layout,
  mcpLinkSummary,
  onConfirm,
  type AppShell,
} from "./layout.ts";
import type { CustomFieldRow } from "../../items/custom-schema.ts";
import type { LibraryWriteMode } from "../../items/schema.ts";
import { staticUrl } from "../static-assets.ts";
import { schemaChoicesMarkup, writeModeChoicesMarkup, writeModeLabel } from "./schema-choice.ts";

export function librariesPage(input: {
  access: Access;
  csrf: string;
  libraries: AppShell["libraries"];
  orphans?: AppShell["orphans"];
  username?: string;
  roleLabel?: string;
}): string {
  const canAdd = can(input.access, "libraries.create");
  const shell: AppShell = {
    libraries: input.libraries,
    orphans: input.orphans,
    csrf: input.csrf,
    canAddLibrary: canAdd,
    showAccounts: can(input.access, "accounts.manage"),
    username: input.username,
    roleLabel: input.roleLabel,
  };
  const waiting = input.libraries.filter((row) => (row.pendingCount ?? 0) > 0);
  const waitingList =
    waiting.length === 0
      ? ""
      : `
        <section class="home-waiting" aria-labelledby="waiting-heading">
          <h2 id="waiting-heading">Pending</h2>
          <p class="hint">These libraries have items waiting to publish.</p>
          <ul class="item-list">
            ${waiting
              .map((row) => {
                const count = row.pendingCount ?? 0;
                const label = count === 1 ? "1 pending" : `${count} pending`;
                return `
              <li>
                <a href="/libraries/${esc(row.id)}?tab=pending">
                  <span class="item-name">${esc(row.name)}</span>
                  <span class="excerpt">${esc(label)}</span>
                </a>
              </li>`;
              })
              .join("")}
          </ul>
        </section>`;
  const firstLibrary =
    input.libraries.length === 0 && (!input.orphans || input.orphans.length === 0);
  const orphanHint =
    input.orphans && input.orphans.length > 0
      ? `<p class="empty-pane-note">Unclaimed libraries are in the left pane. Claim one to become its publisher.</p>`
      : "";

  // First visit: one empty-state stack (title → lead → CTA → note). Other home states keep the list layout.
  if (firstLibrary) {
    if (canAdd) {
      return layout({
        title: "Libraries · MCPEncode",
        csrf: input.csrf,
        access: input.access,
        shell,
        body: `
      <div class="empty-pane empty-pane-start">
        <h1>No libraries yet</h1>
        <p class="empty-pane-lead">Add a library to get started.</p>
        <p class="empty-action"><a class="btn" href="/libraries/new">Add library</a></p>
        <p class="empty-pane-note">Each library has its own items, access list, and MCP link.</p>
      </div>
    `,
      });
    }
    // Reader (or any account that cannot create libraries): they need Access, not a create CTA.
    return layout({
      title: "Libraries · MCPEncode",
      csrf: input.csrf,
      access: input.access,
      shell,
      body: `
      <div class="empty-pane empty-pane-start">
        <p class="home-kicker">Reader</p>
        <h1>No libraries assigned</h1>
        <p class="empty-pane-lead">You can sign in, but you do not have Access to any library yet.</p>
        <p class="empty-pane-note">Ask a publisher or SA to grant you Access on a library. Then it will show up on the left.</p>
      </div>
    `,
    });
  }

  // Catch-up home: either a Pending queue, or a calm “pick a library” surface with Add.
  if (waiting.length > 0) {
    const add = canAdd
      ? `<p class="home-actions"><a class="btn secondary" href="/libraries/new">Add library</a></p>`
      : "";
    return layout({
      title: "Libraries · MCPEncode",
      csrf: input.csrf,
      access: input.access,
      shell,
      body: `
      <div class="empty-pane home-pane">
        <header class="home-head">
          <h1>Libraries</h1>
          ${add}
        </header>
        ${waitingList}
        ${orphanHint}
      </div>
    `,
    });
  }

  const add = canAdd
    ? `<p class="empty-action"><a class="btn" href="/libraries/new">Add library</a></p>`
    : "";
  const idleTitle = canAdd ? "Nothing waiting to publish" : "Your libraries";
  const idleLead = canAdd
    ? "Choose a library on the left to browse items, or add another library."
    : "Choose a library on the left to browse published items.";
  return layout({
    title: "Libraries · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="empty-pane empty-pane-start home-idle">
        <h1>${esc(idleTitle)}</h1>
        <p class="empty-pane-lead">${esc(idleLead)}</p>
        ${add}
        ${orphanHint}
      </div>
    `,
  });
}

/** Add library is its own step in the main pane. The sidebar stays a list. */
export function addLibraryPage(input: {
  access: Access;
  csrf: string;
  libraries: AppShell["libraries"];
  orphans?: AppShell["orphans"];
  shelves?: AppShell["shelves"];
  username?: string;
  roleLabel?: string;
  error?: string;
  name?: string;
  template?: string;
  writeMode?: LibraryWriteMode;
  customFields?: CustomFieldRow[];
}): string {
  const shell: AppShell = {
    libraries: input.libraries,
    orphans: input.orphans,
    shelves: input.shelves,
    csrf: input.csrf,
    canAddLibrary: can(input.access, "libraries.create"),
    addingLibrary: true,
    showAccounts: can(input.access, "accounts.manage"),
    username: input.username,
    roleLabel: input.roleLabel,
  };
  return layout({
    title: "Add library · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    extraScripts: `<script src="${staticUrl("library-name.js")}"></script>
    <script src="${staticUrl("custom-schema.js")}"></script>`,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            <h1>Add library</h1>
          </div>
        </header>
        <p class="hint">Name the library, choose its fields, and choose when items go live.</p>
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/libraries" class="capture add-library-form">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <label>Library name
            <input name="name" required maxlength="200" autocomplete="off" placeholder="Remote access"
              data-name-examples="Remote access|Windows patching|Vendor contacts|On-call runbooks|Acceptable use|Lobby procedures"
              value="${esc(input.name ?? "")}">
          </label>
          ${schemaChoicesMarkup({ selected: input.template, customFields: input.customFields })}
          ${writeModeChoicesMarkup(input.writeMode)}
          <button class="btn add-library-submit" type="submit">Add library</button>
        </form>
      </div>
    `,
  });
}

/** Publishers can switch write mode here. MCP cannot change this. */
function writeModePanel(library: LibraryRow, csrf: string): string {
  const live = library.writeMode === "direct";
  const next = live ? "reviewed" : "direct";
  const confirm = live
    ? `Switch to ${writeModeLabel("reviewed")}? New and edited items will stay Pending until you Publish.`
    : `Switch to ${writeModeLabel("direct")}? New and edited items will be live immediately — no Publish step.`;
  return `
    <form class="write-mode-toggle" method="post" action="/libraries/${esc(library.id)}/write-mode">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="write_mode" value="${next}">
      <span class="write-mode-toggle-label${!live ? " is-current" : ""}">${esc(writeModeLabel("reviewed"))}</span>
      <button type="submit" class="write-mode-toggle-btn${live ? " is-on" : ""}" role="switch"
              aria-checked="${live ? "true" : "false"}"
              aria-label="How writes go live. Now ${esc(writeModeLabel(library.writeMode))}. Switch to ${esc(writeModeLabel(next))}."
              onclick="${onConfirm(confirm)}">
        <span class="write-mode-toggle-knob" aria-hidden="true"></span>
      </button>
      <span class="write-mode-toggle-label${live ? " is-current" : ""}">${esc(writeModeLabel("direct"))}</span>
    </form>`;
}

function columnTypeLabel(type: TableProposal["columns"][number]["type"]): string {
  if (type === "date") return "Date";
  if (type === "longtext") return "Long text";
  return "Text";
}

/** Publishers only. One optional field waiting for Approve. */
function fieldProposalPanel(input: { library: LibraryRow; csrf: string }): string {
  const proposal = input.library.fieldProposal;
  if (!proposal && !input.library.fieldProposalUnreadable) return "";
  if (!proposal) {
    return `
      <section class="table-proposal" aria-labelledby="field-proposal-heading">
        <h2 id="field-proposal-heading">Field waiting for approval</h2>
        <p class="error" role="alert">A field proposal is stored but could not be read. Reject it, then propose again.</p>
        <form method="post" action="/libraries/${esc(input.library.id)}/field/reject">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <button class="btn secondary" type="submit">Reject</button>
        </form>
      </section>`;
  }
  const when = proposal.proposedAt
    ? new Date(proposal.proposedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "";
  return `
    <section class="table-proposal" aria-labelledby="field-proposal-heading">
      <h2 id="field-proposal-heading">Field waiting for approval</h2>
      <p class="hint">An agent proposed this optional field. Approving adds it to items in this library. Existing fields stay as they are. Old items simply will not have a value for it.</p>
      <p class="proposal-name"><strong>${esc(proposal.label)}</strong> · ${esc(columnTypeLabel(proposal.type))} · Optional</p>
      ${proposal.proposedBy ? `<p class="hint">Proposed by <code>${esc(proposal.proposedBy)}</code>${when ? ` · ${esc(when)}` : ""}</p>` : ""}
      <div class="proposal-actions">
        <form method="post" action="/libraries/${esc(input.library.id)}/field/approve">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <button class="btn" type="submit">Approve</button>
        </form>
        <form method="post" action="/libraries/${esc(input.library.id)}/field/reject">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <button class="btn secondary" type="submit">Reject</button>
        </form>
      </div>
    </section>`;
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
  /** Built-in accounts for grant-by-username. Empty when using an external IdP. */
  accounts?: Account[];
}): string {
  const byId = new Map((input.accounts ?? []).map((row) => [row.id, row]));
  const rows =
    input.accessList.length === 0
      ? `<p class="empty">No one on the access list yet.</p>`
      : `<ul class="access-list">
          ${input.accessList
            .map((row) => {
              const person = byId.get(row.subject);
              // Built-in accounts show a name. External IdP grants still show the subject.
              const label = person
                ? `${person.username}${person.disabled ? " (disabled)" : ""}`
                : row.subject;
              const confirmName = person?.username ?? row.subject;
              const detail = person
                ? ""
                : `<span class="access-person-detail"><code>${esc(row.subject)}</code></span>`;
              return `
            <li class="access-person">
              <div class="access-person-main">
                <span class="access-person-name">${esc(label)}</span>
                <span class="access-person-role">${row.role === "publisher" ? "Publisher" : "Reader"}</span>
                ${detail}
              </div>
              <form method="post" action="/libraries/${esc(input.library.id)}/access/revoke" class="access-remove"
                    onsubmit="${onConfirm(`Remove ${confirmName} from ${input.library.name}?`)}">
                <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                <input type="hidden" name="subject" value="${esc(row.subject)}">
                <button type="submit" class="btn danger-ghost"${
                  row.subject === input.viewerSub && row.role === "publisher"
                    ? ' title="You can remove yourself only when another publisher remains"'
                    : ""
                }>Remove</button>
              </form>
            </li>`;
            })
            .join("")}
        </ul>`;

  const grantByPerson = Boolean(input.accounts && input.accounts.length > 0);
  const grantFields = grantByPerson
    ? `<label>User
          <select name="username" required>
            <option value="">Choose someone…</option>
            ${input.accounts!
              .filter((row) => !row.disabled)
              .map(
                (row) =>
                  `<option value="${esc(row.username)}">${esc(row.username)}${
                    row.role === "sa" ? " (SA)" : ""
                  }</option>`,
              )
              .join("")}
          </select>
        </label>`
    : `<label>Subject
          <input name="subject" required maxlength="255" autocomplete="off" placeholder="IdP sub">
        </label>`;

  // Subject copy is only useful when grants still use raw IdP ids.
  const viewerBlock = grantByPerson
    ? ""
    : `<p class="viewer-sub">Your subject is <code id="viewer-sub">${esc(input.viewerSub)}</code>
        <button type="button" class="btn secondary" data-copy="#viewer-sub">Copy</button>
      </p>`;

  return `
    <section class="library-access" aria-labelledby="access-heading">
      <h2 id="access-heading" class="sr-only">Access</h2>
      ${viewerBlock}
      ${rows}
      <form method="post" action="/libraries/${esc(input.library.id)}/access" class="capture">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        ${grantFields}
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

function emptyItems(message: string, libraryId: string, offerAdd: boolean): string {
  const action = offerAdd
    ? `<p class="empty-action"><a class="btn" href="/libraries/${esc(libraryId)}/items/new">Add item</a></p>`
    : "";
  return `<div class="empty-block"><p class="empty">${esc(message)}</p>${action}</div>`;
}

/** Name + summary list. Open the item for field details — not a spreadsheet here. */
function libraryItemRows(library: LibraryRow, items: ItemSummary[], selectable: boolean): string {
  return itemListMarkup(items, library.id, "", false, { selectable });
}

function rowsOrEmpty(
  library: LibraryRow,
  items: ItemSummary[],
  emptyMessage: string,
  offerAdd: boolean,
  selectable: boolean,
  searching: boolean,
): string {
  if (items.length === 0) {
    if (searching) return "";
    return emptyItems(emptyMessage, library.id, offerAdd);
  }
  return libraryItemRows(library, items, selectable);
}

function searchStatus(libraryId: string, tab: LibraryTab, searching: boolean, count: number): string {
  if (!searching) return "";
  const label = count === 0 ? "No items match." : count === 1 ? "1 item matches." : `${count} items match.`;
  return `<p class="search-meta" role="status">${esc(label)} <a href="${libraryTabHref(libraryId, tab)}">Clear</a></p>`;
}

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

function readerKeyWhen(ms: number | null | undefined): string {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/** Publisher control for the one Reader key on this library. Readers do not see it. */
function readerKeyPanel(input: {
  library: LibraryRow;
  csrf: string;
  mcpUrl: string;
  readerKey?: string;
}): string {
  const prefix = input.library.readerKeyPrefix;
  const when = readerKeyWhen(input.library.readerKeyCreatedAt);
  const reveal = input.readerKey;
  const active = Boolean(prefix) && !reveal;
  const lead = reveal
    ? "Copy this Reader key now. It will not be shown again."
    : active
      ? `A Reader key is active (${prefix}…). Shared agents read published items in this library without a sign-in screen.${when ? ` Created ${when}.` : ""}`
      : "For a shared agent such as LibreChat. One key signs in as Reader on this library. People using the agent are not asked to sign in.";
  const secret = reveal
    ? `<div class="mcp-link-box">
        <code class="mcp-link" id="reader-key">${esc(reveal)}</code>
        <button type="button" class="btn mcp-copy" data-copy="#reader-key">Copy</button>
      </div>
      <p class="mcp-panel-note">In LibreChat, use the Connect link as the server URL, send the header below, and set requiresOAuth to false.</p>
      <pre class="reader-key-config" id="reader-key-config">${esc(`type: streamable-http
url: ${input.mcpUrl}
requiresOAuth: false
headers:
  Authorization: Bearer ${reveal}`)}</pre>`
    : "";
  const copyConfig = reveal
    ? `<button type="button" class="btn secondary mcp-copy" data-copy="#reader-key-config">Copy LibreChat config</button>`
    : "";
  const actions = reveal
    ? `${copyConfig}
       <form method="post" action="/libraries/${esc(input.library.id)}/reader-key/remove"
           onsubmit="${onConfirm(`Remove the Reader key for ${input.library.name}? Shared agents using it will stop.`)}">
         <input type="hidden" name="csrf" value="${esc(input.csrf)}">
         <button class="btn secondary" type="submit">Remove</button>
       </form>`
    : active
      ? `<form method="post" action="/libraries/${esc(input.library.id)}/reader-key"
             onsubmit="${onConfirm(`Rotate the Reader key for ${input.library.name}? The current key stops immediately.`)}">
           <input type="hidden" name="csrf" value="${esc(input.csrf)}">
           <button class="btn" type="submit">Rotate</button>
         </form>
         <form method="post" action="/libraries/${esc(input.library.id)}/reader-key/remove"
             onsubmit="${onConfirm(`Remove the Reader key for ${input.library.name}? Shared agents using it will stop.`)}">
           <input type="hidden" name="csrf" value="${esc(input.csrf)}">
           <button class="btn secondary" type="submit">Remove</button>
         </form>`
      : `<form method="post" action="/libraries/${esc(input.library.id)}/reader-key">
           <input type="hidden" name="csrf" value="${esc(input.csrf)}">
           <button class="btn" type="submit">Create Reader key</button>
         </form>`;
  const note = reveal
    ? "Anyone with this key can read published items in this library. If it leaks, rotate it. It cannot change items."
    : active
      ? "The key itself is not shown again. Rotate it if you did not copy it, or if it leaks. It cannot change items or read the audit log."
      : "The key is shown once. It can list and open published items only.";
  return `<details class="mcp-menu"${reveal ? " open" : ""}>
    <summary class="text-summary">Reader key</summary>
    <div class="mcp-panel mcp-panel-wide" role="dialog" aria-label="Reader key for this library">
      <div class="mcp-panel-head">
        <p class="mcp-panel-kicker">This library</p>
        <h2 class="mcp-panel-title">Reader key</h2>
        <p class="mcp-panel-lead">${esc(lead)}</p>
      </div>
      ${secret}
      <div class="reader-key-actions">${actions}</div>
      <p class="mcp-panel-note">${esc(note)}</p>
    </div>
  </details>`;
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
  /** People who can be granted when using built-in sign-in. */
  accounts?: Account[];
  orphan?: boolean;
  /** Flash after bulk Publish, e.g. "3". */
  publishedCount?: string;
  /**
   * Plaintext Reader key. Set only on the one response after Create or Rotate.
   * Later loads show the prefix, not the secret.
   */
  readerKey?: string;
  /** Fixed notice after Approve or Reject. Not raw query text. */
  notice?: string;
  /** Item count used to explain why Approve is unavailable. */
  itemCount?: number;
  /** Libraries for the left pane. */
  shellLibraries: AppShell["libraries"];
  shellOrphans?: AppShell["orphans"];
  shellShelves?: AppShell["shelves"];
  /** Every shelf, so a publisher can move this library onto one. */
  shelfChoices?: { id: string; name: string }[];
  /** Session can add libraries (SA). Independent of library publisher powers. */
  canAddLibrary?: boolean;
  username?: string;
  roleLabel?: string;
  showAccounts?: boolean;
}): string {
  const shell: AppShell = {
    libraries: input.shellLibraries,
    orphans: input.shellOrphans,
    shelves: input.shellShelves,
    activeLibraryId: input.library.id,
    csrf: input.csrf,
    canAddLibrary: input.canAddLibrary ?? can(input.access, "libraries.create"),
    showAccounts: input.showAccounts ?? can(input.access, "accounts.manage"),
    username: input.username,
    roleLabel: input.roleLabel,
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
  const copyDefaultName = `${input.library.name} copy`.replace(/\s+/g, " ").trim().slice(0, 200);
  // Rotate Connect, copy template, rename — Remove on Access still drops one person's grant.
  const actionsMenu = canWrite
    ? `<details class="item-menu">
         ${actionsMenuSummary()}
         <div class="menu-list">
           <form method="post" action="/libraries/${esc(input.library.id)}/connect/rotate"
                onsubmit="${onConfirm(
                  `Rotate the Connect link for ${input.library.name}? Old links stop working. People on Access stay.`,
                )}">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <button type="submit">Rotate connect link</button>
           </form>
           <form class="menu-form" method="post" action="/libraries/${esc(input.library.id)}/copy"
                 onsubmit="${onConfirm(
                   `Copy the template for “${input.library.name}” into a new empty library? Items and Access are not copied.`,
                 )}">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <label class="menu-field">
               <span class="sr-only">Name for the copy</span>
               <input name="name" required maxlength="200" value="${esc(copyDefaultName)}" autocomplete="off">
             </label>
             <button type="submit">Copy library template</button>
           </form>
           <form class="menu-form" method="post" action="/libraries/${esc(input.library.id)}/rename">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <label class="menu-field">
               <span class="sr-only">Library name</span>
               <input name="name" required maxlength="200" value="${esc(input.library.name)}" autocomplete="off">
             </label>
             <button type="submit">Rename library</button>
           </form>
           <form class="menu-form" method="post" action="/libraries/${esc(input.library.id)}/shelf">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <label class="menu-field">
               <span class="sr-only">Shelf</span>
               <select name="shelf_id">
                 <option value=""${input.library.shelfId ? "" : " selected"}>No shelf</option>
                 ${(input.shelfChoices ?? [])
                   .map(
                     (shelf) =>
                       `<option value="${esc(shelf.id)}"${shelf.id === input.library.shelfId ? " selected" : ""}>${esc(shelf.name)}</option>`,
                   )
                   .join("")}
               </select>
             </label>
             <button type="submit">Move to shelf</button>
           </form>
           ${
             can(input.access, "libraries.delete")
               ? `<form class="menu-danger-sep" method="post" action="/libraries/${esc(input.library.id)}/delete"
                    onsubmit="${onConfirm(
                      `Delete library “${input.library.name}” and every item in it? This cannot be undone.`,
                    )}">
                 <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                 <button class="menu-danger" type="submit">Delete library</button>
               </form>`
               : ""
           }
         </div>
       </details>`
    : "";

  const published = input.items.filter((row) => row.status === "published");
  const pending = input.items.filter((row) => row.status === "draft");
  const archived = input.items.filter((row) => row.status === "archived");
  const searching = Boolean(input.q?.trim());
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

  const listedItems = canWrite ? published : input.items;
  const itemsPanel = `
    <section class="library-items" aria-labelledby="items-heading">
      <h2 id="items-heading" class="sr-only">Items</h2>
      ${rowsOrEmpty(input.library, listedItems, "No published items yet.", canWrite, false, searching)}
    </section>`;

  const pendingHint =
    input.library.writeMode === "direct"
      ? `Not live right now. In ${writeModeLabel("direct")}, saving an item makes it live again.`
      : "Drafts waiting to be published. Each row shows what changed. Not visible to the kiosk.";
  const pendingPanel =
    pending.length === 0
      ? `
        <section class="library-items" aria-labelledby="pending-heading">
          <h2 id="pending-heading" class="sr-only">Pending</h2>
          <p class="hint library-tab-hint">${esc(pendingHint)}</p>
          ${rowsOrEmpty(input.library, [], "Nothing pending.", canWrite, false, searching)}
        </section>`
      : `
        <section class="library-items" aria-labelledby="pending-heading">
          <h2 id="pending-heading" class="sr-only">Pending</h2>
          <form method="post" action="/libraries/${esc(input.library.id)}/items/publish" class="pending-publish" id="pending-publish">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <p class="hint library-tab-hint">${esc(pendingHint)}</p>
            <div class="pending-list">
              <div class="pending-list-head">
                <input type="checkbox" id="pending-select-all" class="item-pick" aria-label="Select all pending items">
                <div class="pending-list-head-main">
                  <span class="pending-selection" id="pending-selection" aria-live="polite">Select items</span>
                  <div class="pending-actions">
                    <button class="btn secondary" type="submit" id="pending-cancel-btn" disabled
                      formaction="/libraries/${esc(input.library.id)}/items/cancel"
                      onclick="${onConfirm("Cancel the selected publish requests? Items that were already live go back to the last published version. Items that were never published move to Archives.")}">Cancel</button>
                    <button class="btn" type="submit" id="pending-publish-btn" disabled>Publish</button>
                  </div>
                </div>
              </div>
              ${rowsOrEmpty(input.library, pending, "Nothing pending.", false, true, searching)}
            </div>
          </form>
        </section>`;

  const archivesPanel = `
    <section class="library-items" aria-labelledby="archives-heading">
      <h2 id="archives-heading" class="sr-only">Archives</h2>
      <p class="hint library-tab-hint">Hidden from the kiosk and from Pending.</p>
      ${rowsOrEmpty(input.library, archived, "No archived items.", false, false, searching)}
    </section>`;

  const accessBlock =
    canWrite && input.accessList && input.viewerSub
      ? accessPanel({
          library: input.library,
          csrf: input.csrf,
          accessList: input.accessList,
          viewerSub: input.viewerSub,
          accounts: input.accounts,
        })
      : `<p class="empty">Access is managed by a publisher on this library.</p>`;

  const panel =
    tab === "pending" ? pendingPanel : tab === "archives" ? archivesPanel : tab === "access" ? accessBlock : itemsPanel;

  // Tabs + write-mode switch share one row so the header stays name + actions only.
  const tabs = canWrite
    ? `<div class="library-toolbar">
        <nav class="library-tabs" aria-label="Library">
          <a href="${libraryTabHref(input.library.id, "items", input.q)}"${tab === "items" ? ' aria-current="page"' : ""}>Items</a>
          <a href="${libraryTabHref(input.library.id, "pending", input.q)}"${tab === "pending" ? ' aria-current="page"' : ""}>Pending${tabBadge(pending.length, "pending")}</a>
          <a href="${libraryTabHref(input.library.id, "archives", input.q)}"${tab === "archives" ? ' aria-current="page"' : ""}>Archives${tabBadge(archived.length, "archive")}</a>
          <a href="${libraryTabHref(input.library.id, "access", input.q)}"${tab === "access" ? ' aria-current="page"' : ""}>Access</a>
        </nav>
        ${writeModePanel(input.library, input.csrf)}
      </div>`
    : "";

  const search =
    tab === "access"
      ? ""
      : `<form method="get" action="/libraries/${esc(input.library.id)}" class="search" role="search">
          ${tab === "items" ? "" : `<input type="hidden" name="tab" value="${esc(tab)}">`}
          <label class="sr-only" for="q">Search items</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Search items" autocomplete="off">
          <button type="submit">Search</button>
        </form>
        ${searchStatus(input.library.id, tab, searching, tab === "pending" ? pending.length : tab === "archives" ? archived.length : listedItems.length)}`;

  // The link stays in the header so publishers can copy it without leaving the item list.
  const mcpBlock = `
    <details class="mcp-menu">
      ${mcpLinkSummary()}
      <div class="mcp-panel" role="dialog" aria-label="Connect link for this library">
        <div class="mcp-panel-head">
          <p class="mcp-panel-kicker">This library</p>
          <h2 class="mcp-panel-title">Connect link</h2>
          <p class="mcp-panel-lead">Paste into Cursor or the kiosk. Each person still signs in. For a shared agent, use a Reader key.</p>
        </div>
        <div class="mcp-link-box">
          <code class="mcp-link" id="mcp-url">${esc(input.mcpUrl)}</code>
          <button type="button" class="btn mcp-copy" data-copy="#mcp-url">Copy</button>
        </div>
        <p class="mcp-panel-note">If this link leaks, rotate it under Actions. People on Access stay. Rotating Connect does not change the Reader key.</p>
      </div>
    </details>`;

  const readerKeyBlock = canWrite ? readerKeyPanel(input) : "";

  return layout({
    title: `${input.library.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div class="library-head-row">
            <h1 title="${esc(input.library.name)}">${esc(input.library.name)}</h1>
            <div class="head-actions">
              ${mcpBlock}
              ${readerKeyBlock}
              ${addLink}
              ${actionsMenu}
            </div>
          </div>
        </header>
        ${input.notice ? `<p class="notice" role="status">${esc(input.notice)}</p>` : ""}
        ${bulkNotice}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        ${canWrite ? tableProposalPanel({ library: input.library, csrf: input.csrf, itemCount: input.itemCount ?? 0 }) : ""}
        ${canWrite ? fieldProposalPanel({ library: input.library, csrf: input.csrf }) : ""}
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
              btn.classList.add("is-copied");
              setTimeout(() => {
                btn.textContent = previous || "Copy";
                btn.classList.remove("is-copied");
              }, 1500);
            } catch { /* clipboard can be denied; the link stays visible */ }
          });
        });
        (function mcpMenu() {
          const menus = Array.from(document.querySelectorAll(".mcp-menu"));
          if (menus.length === 0) return;
          document.addEventListener("click", (event) => {
            for (const menu of menus) {
              if (!menu.open) continue;
              if (event.target instanceof Node && menu.contains(event.target)) continue;
              menu.open = false;
            }
          });
          document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            for (const menu of menus) {
              if (!menu.open) continue;
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
          const cancelBtn = document.getElementById("pending-cancel-btn");
          const selection = document.getElementById("pending-selection");
          const boxes = () => Array.from(form.querySelectorAll('input[name="item_id"]'));
          function sync() {
            const all = boxes();
            const checked = all.filter((box) => box.checked);
            if (publishBtn) {
              publishBtn.disabled = checked.length === 0;
              publishBtn.textContent =
                checked.length === 0
                  ? "Publish"
                  : checked.length === 1
                    ? "Publish 1"
                    : "Publish " + checked.length;
            }
            if (cancelBtn) {
              cancelBtn.disabled = checked.length === 0;
              cancelBtn.textContent =
                checked.length === 0
                  ? "Cancel"
                  : checked.length === 1
                    ? "Cancel 1"
                    : "Cancel " + checked.length;
            }
            if (selection) {
              selection.textContent =
                checked.length === 0
                  ? "Select items"
                  : checked.length === all.length
                    ? "All " + checked.length + " selected"
                    : checked.length + " selected";
            }
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
