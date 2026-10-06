/** Shared HTML layout, status labels, and list markup for publisher pages. */
import type { Access } from "../../auth/rbac.ts";
import type { ItemRow, ItemStatus, ItemSummary, LibraryRow, PublishedSnapshot } from "../../db/models.ts";
import { schemaChoicesMarkup, writeModeChoicesMarkup } from "./schema-choice.ts";

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
        <pre class="diff-before">${esc(change.before)}</pre>
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
  if (access.libraryRole === "publisher") return "Publisher";
  if (access.libraryRole === "reader") return "Reader";
  return access.role === "edit" ? "Editor" : "Reader";
}

/** Left-pane library list for the publisher shell. */
export type ShellLibrary = {
  id: string;
  name: string;
  template: string;
  access_role?: string;
};

export type AppShell = {
  libraries: ShellLibrary[];
  orphans?: ShellLibrary[];
  activeLibraryId?: string;
  csrf: string;
  canAddLibrary: boolean;
  addError?: string;
};

function librarySidebar(shell: AppShell): string {
  const addForm = shell.canAddLibrary
    ? `
    <details class="sidebar-add"${shell.addError ? " open" : ""}>
      <summary>Add library</summary>
      <form method="post" action="/libraries" class="sidebar-add-form">
        ${shell.addError ? `<p class="error" role="alert">${esc(shell.addError)}</p>` : ""}
        <input type="hidden" name="csrf" value="${esc(shell.csrf)}">
        <label>Name
          <input name="name" required maxlength="200" autocomplete="off" placeholder="Remote access">
        </label>
        ${schemaChoicesMarkup()}
        ${writeModeChoicesMarkup()}
        <button class="btn" type="submit">Add library</button>
      </form>
    </details>`
    : "";

  const rows =
    shell.libraries.length === 0
      ? `<p class="sidebar-empty">No libraries yet.</p>`
      : `<ul class="sidebar-libs">
          ${shell.libraries
            .map((row) => {
              const active = row.id === shell.activeLibraryId;
              const kind = libraryKind(row.template as LibraryRow["template"]);
              const role =
                row.access_role === "publisher"
                  ? "Publisher"
                  : row.access_role === "reader"
                    ? "Reader"
                    : "";
              return `
            <li>
              <a class="sidebar-lib${active ? " is-active" : ""}" href="/libraries/${esc(row.id)}"${active ? ' aria-current="page"' : ""}>
                <span class="sidebar-lib-name">${esc(row.name)}</span>
                ${kind || role ? `<span class="sidebar-lib-meta">${esc([kind, role].filter(Boolean).join(" · "))}</span>` : ""}
              </a>
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
        <h2 class="sidebar-title">Libraries</h2>
        ${addForm}
      </div>
      <nav class="sidebar-nav" aria-label="Your libraries">
        ${rows}
        ${orphans}
      </nav>
    </aside>`;
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
            ? `<p class="nav-context">${
                input.library
                  ? `<span class="nav-current">${esc(input.library.name)}</span>`
                  : `<span class="nav-muted">Libraries</span>`
              }</p>`
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
          ${librarySidebar(input.shell)}
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
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@450;600;700&display=swap" rel="stylesheet">
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
