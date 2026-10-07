/** Shared HTML layout, status labels, and list markup for publisher pages. */
import type { Access } from "../../auth/rbac.ts";
import type { ItemRow, ItemStatus, ItemSummary, LibraryRow, PublishedSnapshot } from "../../db/models.ts";
import { isLibraryWriteMode, type LibraryWriteMode } from "../../items/schema.ts";

/** Keep in sync with writeModeLabel in schema-choice (avoid a layout ↔ schema-choice import cycle). */
function shellWriteModeLabel(mode: LibraryWriteMode): string {
  return mode === "direct" ? "Live Sync" : "Publisher Review";
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

export function noticeMessage(notice: string | undefined, status: ItemStatus): string {
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
  if (status === "draft") {
    return "Pending — not visible to the kiosk until Published.";
  }
  if (status === "archived") {
    return "Archived — not visible to the kiosk.";
  }
  return "Published — visible to readers and the kiosk.";
}

export function labelsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function publishDiff(item: ItemRow, snapshot: PublishedSnapshot | null): string {
  if (!snapshot) {
    return `<p class="hint">Never published.</p>`;
  }
  const changes: { field: string; before: string; after: string }[] = [];
  if (item.name !== snapshot.name) {
    changes.push({ field: "Name", before: snapshot.name, after: item.name });
  }
  if (!labelsEqual(item.labels, snapshot.labels)) {
    changes.push({
      field: "Labels",
      before: snapshot.labels.join(", ") || "(none)",
      after: item.labels.join(", ") || "(none)",
    });
  }
  if (item.summary !== snapshot.summary) {
    changes.push({ field: "Summary", before: snapshot.summary, after: item.summary });
  }
  if (item.body !== snapshot.body) {
    changes.push({ field: "Body", before: snapshot.body, after: item.body });
  }
  if ((item.details ?? "") !== (snapshot.details ?? "")) {
    changes.push({
      field: "Details",
      before: snapshot.details ?? "(none)",
      after: item.details ?? "(none)",
    });
  }
  if (changes.length === 0) {
    return `<p class="hint">No changes since last published.</p>`;
  }
  return `<ul class="diff-list">
    ${changes
      .map(
        (change) => `
      <li>
        <p class="diff-field">${esc(change.field)}</p>
        <p class="diff-label">Published</p>
        <pre class="diff-before">${esc(change.before)}</pre>
        <p class="diff-label">Now</p>
        <pre class="diff-after">${esc(change.after)}</pre>
      </li>`,
      )
      .join("")}
  </ul>`;
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
        const body = `
          <span class="item-name-row">
            <span class="item-name">${esc(row.name)}</span>
            ${showStatus ? statusBadge(row.status) : ""}
          </span>
          ${row.summary ? `<span class="excerpt">${esc(row.summary)}</span>` : ""}
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
  /** Drafts waiting to publish. Set only when this person is a publisher on the library. */
  pendingCount?: number;
};

export type AppShell = {
  libraries: ShellLibrary[];
  orphans?: ShellLibrary[];
  activeLibraryId?: string;
  csrf: string;
  canAddLibrary: boolean;
  /** Add library page: the sidebar link is the current page. */
  addingLibrary?: boolean;
  /** Home and Accounts: this sign-in can create more accounts. */
  showAccounts?: boolean;
};

/** confirm() text safe to place in a double-quoted onsubmit attribute. */
export function onConfirm(message: string): string {
  const js = message
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
  return `return confirm('${esc(js)}');`;
}

function librarySidebar(shell: AppShell): string {
  const addLink = shell.canAddLibrary
    ? `<a class="sidebar-add-link${shell.addingLibrary ? " is-active" : ""}" href="/libraries/new" aria-label="Add library"${
        shell.addingLibrary ? ' aria-current="page"' : ""
      }><span aria-hidden="true">+</span></a>`
    : "";

  const rows =
    shell.libraries.length === 0
      ? `<p class="sidebar-empty">No libraries yet.</p>`
      : `<ul class="sidebar-libs">
          ${shell.libraries
            .map((row) => {
              const active = row.id === shell.activeLibraryId;
              const mode =
                row.writeMode && isLibraryWriteMode(row.writeMode)
                  ? shellWriteModeLabel(row.writeMode)
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
                </span>
              </a>
              ${pending}
            </li>`;
            })
            .join("")}
        </ul>`;

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
      <nav class="sidebar-nav" aria-label="Your libraries">
        ${rows}
        ${orphans}
      </nav>
    </aside>`;
}

function shellCurrentLabel(shell: AppShell): string {
  if (shell.addingLibrary) return "Add library";
  const active =
    shell.libraries.find((row) => row.id === shell.activeLibraryId) ??
    shell.orphans?.find((row) => row.id === shell.activeLibraryId);
  return active?.name ?? "Choose a library";
}

export function layout(input: {
  title: string;
  csrf?: string;
  access?: Access;
  extraHead?: string;
  library?: { id: string; name: string };
  /** When set, renders libraries on the left and body on the right. */
  shell?: AppShell;
  body: string;
}): string {
  const shellMode = Boolean(input.access && input.shell);
  const nav = input.access
    ? `<nav class="nav" aria-label="Main">
        <a class="brand" href="/">MCPEncode</a>
        ${
          shellMode
            ? input.library
              ? `<p class="nav-context"><span class="nav-current">${esc(input.library.name)}</span></p>`
              : ""
            : `<div class="nav-trail">
          <a class="nav-link" href="/">Library</a>
          ${
            input.library
              ? `<span class="nav-sep" aria-hidden="true">/</span>
                 <a class="nav-link nav-current" href="/libraries/${esc(input.library.id)}">${esc(input.library.name)}</a>`
              : ""
          }
        </div>`
        }
        <div class="nav-end">
          <span class="nav-role">${esc(roleLabel(input.access))}</span>
          ${
            input.shell?.showAccounts
              ? `<a class="nav-signout" href="/accounts">Accounts</a>`
              : ""
          }
          <a class="nav-signout" href="/logout">Sign out</a>
        </div>
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
              <span class="lib-nav-kicker">Libraries</span>
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@450;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/styles.css">
  ${input.extraHead ?? ""}
</head>
<body class="${shellMode ? "app-body" : ""}">
  ${nav}
  ${content}
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
    <script src="/static/editor.js"></script>
  `;
}
