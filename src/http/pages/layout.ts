/** Shared HTML layout, status labels, and list markup for publisher pages. */
import type { Access } from "../../auth/rbac.ts";
import type { ItemRow, ItemStatus, ItemSummary, LibraryRow, PublishedSnapshot } from "../../db/models.ts";
import type { LibrarySchema } from "../../items/library-schema.ts";
import { focusChange, itemReview, sideDiff, type DiffSpan, type ItemReview } from "../../items/review.ts";
import { isLibraryWriteMode, type LibraryWriteMode } from "../../items/schema.ts";
import { staticUrl } from "../static-assets.ts";

/** Keep in sync with writeModeLabel in schema-choice (avoid a layout ↔ schema-choice import cycle). */
function shellWriteModeLabel(mode: LibraryWriteMode): string {
  return mode === "direct" ? "Review Unlock" : "Review Lock";
}

export function libraryKind(template: LibraryRow["template"]): string {
  if (template === "policy") return "Policy";
  if (template === "procedure") return "Procedure";
  if (template === "table") return "Table";
  // Free-form libraries have no type label — "General" is internal only.
  return "";
}

export function kindKicker(template: LibraryRow["template"]): string {
  const kind = libraryKind(template);
  return kind ? `<p class="kicker">${esc(kind)}</p>` : "";
}

export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Header control that opens the library MCP URL panel. */
export function mcpLinkSummary(): string {
  return `<summary class="text-summary">Connect</summary>`;
}

/** Compact header control: overflow menu for destructive actions. */
export function actionsMenuSummary(): string {
  return `<summary class="icon-summary" aria-label="Actions">
    <svg class="icon-summary-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="5" r="1.75" fill="currentColor"/>
      <circle cx="12" cy="12" r="1.75" fill="currentColor"/>
      <circle cx="12" cy="19" r="1.75" fill="currentColor"/>
    </svg>
  </summary>`;
}

export function statusLabel(status: ItemStatus): string {
  if (status === "published") return "Published";
  if (status === "archived") return "Archived";
  return "Pending";
}

export function statusBadge(status: ItemStatus): string {
  return `<span class="status status-${esc(status)}">${esc(statusLabel(status))}</span>`;
}

/**
 * Flash copy after a save/publish/archive. Empty when there is no flash —
 * the status pill already covers standing state.
 */
export function noticeMessage(notice: string | undefined, _status?: ItemStatus): string {
  if (notice === "created") {
    return "Item saved as Pending. Publish it when it is ready for the kiosk.";
  }
  if (notice === "created_live") {
    return "Item saved and live. Readers and agents can see it now.";
  }
  if (notice === "pending") {
    return "Moved to Pending. It is hidden from the kiosk until you Publish again.";
  }
  if (notice === "saved_live") {
    return "Saved and live. Readers and agents see this version now.";
  }
  if (notice === "published") {
    return "Published. Readers and the kiosk can see this item.";
  }
  if (notice === "archived") {
    return "Archived. Hidden from the kiosk and from Pending.";
  }
  if (notice === "restored") {
    return "Restored to Pending. Publish when it is ready for the kiosk.";
  }
  if (notice === "canceled") {
    return "Publish request canceled. This item is back to the last published version.";
  }
  if (notice === "canceled_new") {
    return "Publish request canceled. This item was never published, so it is Archived.";
  }
  if (notice === "reverted") {
    return "Reverted to the last published version. Item is Pending — Publish when it should be live again.";
  }
  if (notice === "reverted_previous") {
    return "Reverted to the previous published version. Item is Pending — Publish when it should be live again. Readers still see the current published copy until you Publish.";
  }
  if (notice === "file_added") return "File added.";
  if (notice === "file_pending") {
    return "File added. This item is Pending until you Publish.";
  }
  if (notice === "file_removed") return "File removed.";
  if (notice === "file_removed_pending") {
    return "File removed. This item is Pending until you Publish.";
  }
  if (notice === "file_too_many") return "This item already has 5 files.";
  if (notice === "file_too_big") return "That file is over 10 MB.";
  if (notice === "file_type") return "Use a PDF or an image (PNG, JPEG, or WebP).";
  if (notice === "file_empty") return "That file is empty.";
  if (notice === "file_missing") return "Choose a file to add.";
  return "";
}

function shown(value: string): string {
  return value.trim() ? value : "(none)";
}

/** Escape each span, then wrap only the changed words. */
function highlightSpans(spans: DiffSpan[]): string {
  return spans
    .map((span) => {
      const text = esc(span.text);
      if (span.op === "equal") return text;
      if (span.op === "delete") return `<mark class="diff-del">${text}</mark>`;
      return `<mark class="diff-ins">${text}</mark>`;
    })
    .join("");
}

/** Before/after with shared words plain and the edit marked. */
function highlightedSides(before: string, after: string): { before: string; after: string } {
  const sides = sideDiff(shown(before), shown(after));
  return {
    before: highlightSpans(sides.before),
    after: highlightSpans(sides.after),
  };
}

/** Pending list: short fields in place, long fields named. */
function reviewList(review: ItemReview): string {
  if (review.kind === "new") return `<span class="review-badge">New</span>`;
  if (review.kind === "unchanged") {
    return `<span class="review-note">No changes since last published</span>`;
  }
  const long = review.fields.some((field) => field.long);
  const rows = review.fields
    .map((field) => {
      if (field.long) {
        return `<li class="review-change"><span class="review-field">${esc(field.label)}</span></li>`;
      }
      const sides = highlightedSides(field.before, field.after);
      return `<li class="review-change">
        <span class="review-field">${esc(field.label)}</span>
        <span class="review-side"><span class="review-k">Published</span> ${sides.before}</span>
        <span class="review-side"><span class="review-k">Now</span> ${sides.after}</span>
      </li>`;
    })
    .join("");
  const hint = long ? `<span class="review-hint">Open the item to read the full text.</span>` : "";
  return `<ul class="review-list">${rows}</ul>${hint}`;
}

/** Item page: every changed field, with long text narrowed to the edit. */
function reviewFull(review: ItemReview): string {
  if (review.kind === "new") return `<p class="hint">New item. Nothing has been published yet.</p>`;
  if (review.kind === "unchanged") return `<p class="hint">No changes since last published.</p>`;
  return `<ul class="diff-list">
    ${review.fields
      .map((field) => {
        const text = field.long ? focusChange(field.before, field.after) : { ...field, trimmed: false };
        const note = text.trimmed ? `<p class="hint">Showing the part that changed.</p>` : "";
        const sides = highlightedSides(text.before, text.after);
        return `<li>
          <p class="diff-field">${esc(field.label)}</p>
          ${note}
          <p class="diff-label">Published</p>
          <pre class="diff-before">${sides.before}</pre>
          <p class="diff-label">Now</p>
          <pre class="diff-after">${sides.after}</pre>
        </li>`;
      })
      .join("")}
  </ul>`;
}

export function reviewMarkup(review: ItemReview, mode: "list" | "full"): string {
  return mode === "list" ? reviewList(review) : reviewFull(review);
}

const generalReviewSchema: LibrarySchema = {
  starter: "general",
  fields: [{ key: "body", label: "Description", type: "markdown", required: false, kind: "body" }],
};

/** Pending item: the comparison sits above the content, before Publish. */
export function itemReviewBlock(item: ItemRow, schema: LibrarySchema): string {
  if (item.status !== "draft") return "";
  const review = itemReview(item, item.published_snapshot, schema);
  return `<section class="item-review" aria-labelledby="what-changed">
    <h2 id="what-changed">What changed</h2>
    ${reviewMarkup(review, "full")}
  </section>`;
}

export function publishDiff(item: ItemRow, snapshot: PublishedSnapshot | null): string {
  return reviewMarkup(itemReview(item, snapshot, generalReviewSchema), "full");
}

export function itemListMarkup(
  items: ItemSummary[],
  libraryId: string,
  emptyMessage: string,
  showStatus: boolean,
  options: { selectable?: boolean } = {},
): string {
  if (items.length === 0) {
    return `<p class="empty">${esc(emptyMessage)}</p>`;
  }
  const selectable = options.selectable === true;
  return `<ul class="item-list${selectable ? " item-list-selectable" : ""}">
    ${items
      .map((row) => {
        const labels = row.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");
        const summaryInReview =
          row.review?.kind === "changed" &&
          row.review.fields.some((field) => field.label === "Summary" && !field.long);
        const body = `
          <span class="item-name-row">
            <span class="item-name">${esc(row.name)}</span>
            ${showStatus ? statusBadge(row.status) : ""}
          </span>
          ${summaryInReview || !row.summary ? "" : `<span class="excerpt">${esc(row.summary)}</span>`}
          ${row.review ? reviewMarkup(row.review, "list") : ""}
          ${labels ? `<span class="item-labels">${labels}</span>` : ""}`;
        if (selectable) {
          return `
      <li class="item-row">
        <input type="checkbox" name="item_id" value="${esc(row.id)}" id="pick-${esc(row.id)}" class="item-pick">
        <a href="/items/${esc(row.id)}?library=${esc(libraryId)}" class="item-link">
          ${body}
        </a>
      </li>`;
        }
        return `
      <li>
        <a href="/items/${esc(row.id)}?library=${esc(libraryId)}">
          ${body}
        </a>
      </li>`;
      })
      .join("")}
  </ul>`;
}

export function roleLabel(access: Access): string {
  if (access.role === "sa") return "SA";
  if (access.libraryRole === "publisher") return "Publisher";
  if (access.libraryRole === "reader") return "Reader";
  return "Reader";
}

/** Left-pane library list for the publisher shell. */
export type ShellLibrary = {
  id: string;
  name: string;
  template: string;
  /** How writes go live. Shown under the name instead of schema/role. */
  writeMode?: "reviewed" | "direct";
  access_role?: string;
  /** Published items in this library (Items tab). */
  itemCount?: number;
  /** Drafts waiting to publish. Set only when this person is a publisher on the library. */
  pendingCount?: number;
  /** Shelf this library is searched with. Absent when it stands alone. */
  shelfId?: string | null;
  shelfName?: string | null;
};

export type ShellShelf = {
  id: string;
  name: string;
};

export type AppShell = {
  libraries: ShellLibrary[];
  orphans?: ShellLibrary[];
  /** Shelves this person can open. SA also sees empty shelves. */
  shelves?: ShellShelf[];
  activeLibraryId?: string;
  activeShelfId?: string;
  addingShelf?: boolean;
  csrf: string;
  canAddLibrary: boolean;
  /** Add library page: the sidebar link is the current page. */
  addingLibrary?: boolean;
  /** Home and Accounts: this sign-in can create more accounts. */
  showAccounts?: boolean;
  /** Sidebar footer — who is signed in. */
  username?: string;
  /** App admin label for the footer ("SA" or empty). */
  roleLabel?: string;
  /** Left pane lists Settings items instead of libraries. */
  settingsMode?: boolean;
  /** Which Settings item is current. */
  settingsActive?: "accounts" | "apps";
};

/**
 * Text for a data-confirm attribute (double-quoted). public/page.js asks it
 * with confirm() before the form submits; no inline handler, so the CSP can
 * refuse inline script.
 */
export function confirmText(message: string): string {
  return esc(message.replaceAll("\r", ""));
}

/** Warn before granting app SA (destructive admin). */
export function saGrantConfirm(who: string): string {
  return (
    `Make ${who} an SA?\n\n` +
    "SA can manage every account, open every library, and perform destructive actions " +
    "(hard-delete items, delete libraries).\n\n" +
    "Only continue if you trust them with full admin access."
  );
}

function userInitial(username: string): string {
  const ch = username.trim().charAt(0);
  return (ch || "?").toUpperCase();
}

const SETTINGS_COG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

function sidebarFooter(shell: AppShell): string {
  const name = shell.username?.trim() || "Signed in";
  const role = shell.roleLabel?.trim() || "";
  const settingsOpen = Boolean(shell.settingsMode);
  // One control: open Settings from libraries, close Settings back to libraries.
  const href = settingsOpen ? "/" : "/settings";
  const label = settingsOpen ? "Close settings" : "Settings";
  return `
    <div class="sidebar-foot">
      <div class="sidebar-user">
        <span class="sidebar-user-avatar" aria-hidden="true">${esc(userInitial(name))}</span>
        <span class="sidebar-user-meta">
          <span class="sidebar-user-name">${esc(name)}</span>
          ${role ? `<span class="sidebar-user-role">${esc(role)}</span>` : ""}
        </span>
      </div>
      <a class="sidebar-settings${settingsOpen ? " is-active" : ""}" href="${href}" aria-label="${esc(label)}"${
        settingsOpen ? ' aria-expanded="true"' : ' aria-expanded="false"'
      }>${SETTINGS_COG}</a>
    </div>`;
}

function settingsSidebar(shell: AppShell): string {
  const accountsActive = shell.settingsActive === "accounts";
  const accounts = shell.showAccounts
    ? `<li>
        <a class="sidebar-lib${accountsActive ? " is-active" : ""}" href="/accounts"${
          accountsActive ? ' aria-current="page"' : ""
        }>
          <span class="sidebar-lib-text">
            <span class="sidebar-lib-name">Accounts</span>
            <span class="sidebar-lib-meta">Who can sign in</span>
          </span>
        </a>
      </li>`
    : "";
  const appsActive = shell.settingsActive === "apps";
  const apps = shell.showAccounts
    ? `<li>
        <a class="sidebar-lib${appsActive ? " is-active" : ""}" href="/apps"${appsActive ? ' aria-current="page"' : ""}>
          <span class="sidebar-lib-text">
            <span class="sidebar-lib-name">Apps</span>
            <span class="sidebar-lib-meta">Approve hosted apps</span>
          </span>
        </a>
      </li>`
    : "";
  return `
    <aside class="lib-sidebar" aria-label="Settings">
      <div class="sidebar-head">
        <div class="sidebar-head-row">
          <h2 class="sidebar-title">Settings</h2>
        </div>
      </div>
      <nav class="sidebar-nav" aria-label="Settings">
        <ul class="sidebar-libs">
          ${accounts}
          ${apps}
          <li>
            <a class="sidebar-lib" href="/logout">
              <span class="sidebar-lib-text">
                <span class="sidebar-lib-name">Sign out</span>
              </span>
            </a>
          </li>
        </ul>
      </nav>
      ${sidebarFooter(shell)}
    </aside>`;
}

function librarySidebar(shell: AppShell): string {
  if (shell.settingsMode) return settingsSidebar(shell);

  const addLink = shell.canAddLibrary
    ? `<a class="sidebar-add-link${shell.addingLibrary ? " is-active" : ""}" href="/libraries/new" aria-label="Add library"${
        shell.addingLibrary ? ' aria-current="page"' : ""
      }><span aria-hidden="true">+</span></a>`
    : "";

  const libraryRows =
    shell.libraries.length === 0
      ? `<p class="sidebar-empty">${
          shell.canAddLibrary ? "No libraries yet." : "No libraries assigned."
        }</p>`
      : `<ul class="sidebar-libs">${shell.libraries.map((row) => librarySidebarRow(shell, row)).join("")}</ul>`;

  const orphans =
    shell.orphans && shell.orphans.length > 0
      ? `
      <div class="sidebar-orphans">
        <p class="sidebar-section-label">Unclaimed</p>
        <ul class="sidebar-libs">
          ${shell.orphans
            .map(
              (row) => `
            <li>
              <a class="sidebar-lib" href="/libraries/${esc(row.id)}">
                <span class="sidebar-lib-name">${esc(row.name)}</span>
                <span class="sidebar-lib-meta">Claim</span>
              </a>
            </li>`,
            )
            .join("")}
        </ul>
      </div>`
      : "";

  return `
    <aside class="lib-sidebar" aria-label="Libraries">
      <div class="sidebar-head">
        <div class="sidebar-head-row">
          <h2 class="sidebar-title"><a href="/">Libraries</a></h2>
          ${addLink}
        </div>
      </div>
      <nav class="sidebar-nav" aria-label="Libraries and shelves">
        ${libraryRows}
        ${sidebarShelfSection(shell)}
        ${orphans}
      </nav>
      ${sidebarFooter(shell)}
    </aside>`;
}

function librarySidebarRow(shell: AppShell, row: ShellLibrary): string {
  const active = row.id === shell.activeLibraryId;
  const mode =
    row.writeMode && isLibraryWriteMode(row.writeMode) ? shellWriteModeLabel(row.writeMode) : "";
  const items =
    typeof row.itemCount === "number"
      ? `<span class="sidebar-lib-count">${row.itemCount}<span class="sr-only"> items</span></span>`
      : "";
  const pending =
    typeof row.pendingCount === "number" && row.pendingCount > 0
      ? `<a class="sidebar-pending" href="/libraries/${esc(row.id)}?tab=pending">${row.pendingCount}<span class="sr-only"> pending</span></a>`
      : "";
  return `
            <li class="sidebar-lib-row${active ? " is-active" : ""}">
              <a class="sidebar-lib${active ? " is-active" : ""}" href="/libraries/${esc(row.id)}"${active ? ' aria-current="page"' : ""}>
                <span class="sidebar-lib-text">
                  <span class="sidebar-lib-name">${esc(row.name)}</span>
                  ${mode ? `<span class="sidebar-lib-meta">${esc(mode)}</span>` : ""}
                  ${row.shelfName ? `<span class="sidebar-lib-meta">${esc(row.shelfName)}</span>` : ""}
                </span>
                ${items}
              </a>
              ${pending}
            </li>`;
}

/** My shelves sits under the library list. Add shelf lives in this section. */
function sidebarShelfSection(shell: AppShell): string {
  const shelves = [...(shell.shelves ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  if (!shell.canAddLibrary && shelves.length === 0) return "";
  const add = shell.canAddLibrary
    ? `<a class="sidebar-shelf-add${shell.addingShelf ? " is-active" : ""}" href="/shelves/new"${
        shell.addingShelf ? ' aria-current="page"' : ""
      }>Add shelf</a>`
    : "";
  const rows =
    shelves.length === 0
      ? `<p class="sidebar-shelf-empty">No shelves yet.</p>`
      : shelves
          .map((shelf) => {
            const active = shelf.id === shell.activeShelfId;
            return `
        <a class="sidebar-lib sidebar-shelf-link${active ? " is-active" : ""}" href="/shelves/${esc(shelf.id)}"${
          active ? ' aria-current="page"' : ""
        }>
          <span class="sidebar-lib-text">
            <span class="sidebar-lib-name">${esc(shelf.name)}</span>
          </span>
        </a>`;
          })
          .join("");
  return `
    <section class="sidebar-shelf-section" aria-labelledby="my-shelves-heading">
      <div class="sidebar-section-head">
        <p class="sidebar-section-label" id="my-shelves-heading">My shelves</p>
        ${add}
      </div>
      ${rows}
    </section>`;
}

function shellCurrentLabel(shell: AppShell): string {
  if (shell.settingsMode) {
    if (shell.settingsActive === "accounts") return "Accounts";
    if (shell.settingsActive === "apps") return "Apps";
    return "Settings";
  }
  if (shell.addingShelf) return "Add shelf";
  if (shell.addingLibrary) return "Add library";
  const shelf = shell.shelves?.find((row) => row.id === shell.activeShelfId);
  if (shelf) return shelf.name;
  const active =
    shell.libraries.find((row) => row.id === shell.activeLibraryId) ??
    shell.orphans?.find((row) => row.id === shell.activeLibraryId);
  return active?.name ?? "Choose a library";
}

function shellDrawerKicker(shell: AppShell): string {
  return shell.settingsMode ? "Settings" : "Libraries";
}

export function layout(input: {
  title: string;
  csrf?: string;
  access?: Access;
  extraHead?: string;
  /** Scripts after the page body. Used by Add library’s custom field list. */
  extraScripts?: string;
  library?: { id: string; name: string };
  /** When set, renders libraries on the left and body on the right. */
  shell?: AppShell;
  body: string;
}): string {
  const shellMode = Boolean(input.access && input.shell);
  // Shell pages keep the top bar slim — username, Accounts, and Sign out live in the sidebar.
  const nav = input.access
    ? `<nav class="nav" aria-label="Main">
        <a class="brand" href="/">MCPEncode</a>
        ${
          shellMode
            ? input.library
              ? `<p class="nav-context"><span class="nav-current">${esc(input.library.name)}</span></p>`
              : input.shell?.settingsMode
                ? `<p class="nav-context"><span class="nav-current">Settings</span></p>`
                : ""
            : `<div class="nav-trail">
          <a class="nav-link" href="/">Library</a>
          ${
            input.library
              ? `<span class="nav-sep" aria-hidden="true">/</span>
                 <a class="nav-link nav-current" href="/libraries/${esc(input.library.id)}">${esc(input.library.name)}</a>`
              : ""
          }
        </div>
        <div class="nav-end">
          <span class="nav-role">${esc(roleLabel(input.access))}</span>
          <a class="nav-signout" href="/logout">Sign out</a>
        </div>`
        }
      </nav>`
    : `<nav class="nav" aria-label="Main">
        <a class="brand" href="/">MCPEncode</a>
        <div class="nav-end">
          <a class="nav-signout" href="/login">Sign in</a>
        </div>
      </nav>`;

  const content =
    shellMode && input.shell
      ? `<div class="app-shell">
          <div class="lib-drawer">
            <input type="checkbox" id="lib-nav-toggle" class="lib-nav-toggle">
            <label for="lib-nav-toggle" class="lib-nav-label">
              <span class="lib-nav-kicker">${esc(shellDrawerKicker(input.shell))}</span>
              <span class="lib-nav-current">${esc(shellCurrentLabel(input.shell))}</span>
              <span class="lib-nav-action lib-nav-show">Show</span>
              <span class="lib-nav-action lib-nav-hide">Hide</span>
            </label>
            ${librarySidebar(input.shell)}
          </div>
          <main class="app-main" id="main">
            ${input.body}
          </main>
        </div>`
      : `<main class="wrap">
          ${input.body}
        </main>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.title)}</title>
  ${input.csrf ? `<meta name="csrf-token" content="${esc(input.csrf)}">` : ""}
  <link rel="stylesheet" href="${staticUrl("styles.css")}">
  ${input.extraHead ?? ""}
</head>
<body class="${shellMode ? "app-body" : ""}">
  ${nav}
  ${content}
  <script src="${staticUrl("page.js")}"></script>
  ${input.extraScripts ?? ""}
</body>
</html>`;
}

export function spreadsheetHead(): string {
  return `<link rel="stylesheet" href="/vendor/jsuites/jsuites.css">
  <link rel="stylesheet" href="/vendor/jspreadsheet/jspreadsheet.css">`;
}

export function editorScripts(): string {
  return `
    <script src="/vendor/jsuites/jsuites.js"></script>
    <script src="/vendor/jspreadsheet/index.js"></script>
    <script src="${staticUrl("editor.js")}"></script>
  `;
}
