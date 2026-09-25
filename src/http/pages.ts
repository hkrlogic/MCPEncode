import { can, type Access } from "../auth/rbac.ts";
import type { LibraryRow, RecordRow, RecordSummary } from "../db/queries.ts";
import {
  EMPTY_TABLE,
  splitSummaryAndTable,
  tableToSheetData,
  type MdTable,
} from "../markdown/table.ts";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(input: {
  title: string;
  csrf?: string;
  access?: Access;
  extraHead?: string;
  library?: { id: string; name: string };
  body: string;
}): string {
  const nav = input.access
    ? `<nav class="nav">
        <a href="/">Libraries</a>
        ${
          input.library
            ? `<a href="/libraries/${esc(input.library.id)}">${esc(input.library.name)}</a>`
            : ""
        }
        <span class="who">${esc(input.access.role)} · ${esc(input.access.sub)}</span>
        <a href="/logout">Sign out</a>
      </nav>`
    : `<nav class="nav"><span class="brand">Mpos</span></nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.title)}</title>
  ${input.csrf ? `<meta name="csrf-token" content="${esc(input.csrf)}">` : ""}
  <link rel="stylesheet" href="/static/styles.css">
  ${input.extraHead ?? ""}
</head>
<body>
  ${nav}
  <main class="wrap">
    ${input.body}
  </main>
</body>
</html>`;
}

export function loginPage(): string {
  return layout({
    title: "Sign in · Mpos",
    body: `
      <section class="hero">
        <h1>Libraries</h1>
        <p>Precise libraries of items you can publish for people and agents. Sign in to view or add libraries.</p>
        <a class="btn" href="/login">Sign in</a>
      </section>
    `,
  });
}

function spreadsheetHead(): string {
  return `<link rel="stylesheet" href="/vendor/jsuites/jsuites.css">
  <link rel="stylesheet" href="/vendor/jspreadsheet/jspreadsheet.css">`;
}

function editorScripts(): string {
  return `
    <script src="/vendor/jsuites/jsuites.js"></script>
    <script src="/vendor/jspreadsheet/index.js"></script>
    <script src="/static/editor.js"></script>
  `;
}

function summaryField(summary: string, required: boolean): string {
  return `
    <label>Summary
      <input name="summary" maxlength="160" ${required ? "required" : ""} value="${esc(summary)}"
        placeholder="One line. This is what search shows." autocomplete="off">
    </label>
  `;
}

function tableMarkup(table: MdTable): string {
  return `
    <div class="section">
      <p class="sheet-label">Table</p>
      <p class="hint">Optional grid. Leave blank if you pasted the item above.</p>
      <div class="sheet-wrap">
        <div id="spreadsheet" data-table="${esc(JSON.stringify(tableToSheetData(table)))}"></div>
      </div>
      <textarea id="notes" name="notes" class="sr-only" maxlength="50000"></textarea>
      <div class="preview" id="preview" aria-live="polite"><p class="hint">Table preview</p></div>
    </div>
  `;
}

function descriptionMarkup(description: string): string {
  return `
    <div class="section section-data">
      <label for="description">Data</label>
      <p class="hint">Primary place to paste this item. Markdown is fine. The summary above is only the one-liner search shows.</p>
      <div class="editor">
        <textarea id="description" name="description" rows="18" maxlength="50000"
          placeholder="Paste the item here.">${esc(description)}</textarea>
        <div class="preview" id="description-preview" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function captureEditor(notes: string, summaryRequired: boolean): string {
  const split = splitSummaryAndTable(notes);
  return `${summaryField(split.summary, summaryRequired)}${descriptionMarkup(split.description)}${tableMarkup(split.table ?? EMPTY_TABLE)}`;
}

function itemFields(input: { title: string; tags: string; notes: string; summaryRequired: boolean }): string {
  return `
        <div class="row">
          <label>Name
            <input name="title" required maxlength="200" value="${esc(input.title)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="tags" value="${esc(input.tags)}" placeholder="ops, poc" autocomplete="off">
          </label>
        </div>
        ${captureEditor(input.notes, input.summaryRequired)}
  `;
}

export function librariesPage(input: {
  access: Access;
  csrf: string;
  libraries: LibraryRow[];
  error?: string;
}): string {
  const form = can(input.access, "records.write")
    ? `
    <section class="panel">
      <h2>Add library</h2>
      ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
      <form method="post" action="/libraries" class="capture">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <label>Name
          <input name="name" required maxlength="200" autocomplete="off" placeholder="Windows patching">
        </label>
        <button class="btn" type="submit">Add library</button>
      </form>
    </section>`
    : `<p class="hint">Read-only: you can open libraries but not add new ones.</p>`;

  const list =
    input.libraries.length === 0
      ? `<p class="empty">No libraries yet.</p>`
      : `<ul class="cards">
          ${input.libraries
            .map(
              (row) => `
            <li>
              <a href="/libraries/${esc(row.id)}">
                <h3>${esc(row.name)}</h3>
              </a>
            </li>`,
            )
            .join("")}
        </ul>`;

  return layout({
    title: "Libraries · Mpos",
    csrf: input.csrf,
    access: input.access,
    body: `
      ${form}
      <section>
        <h2>Libraries</h2>
        ${list}
      </section>
    `,
  });
}

export function libraryPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  records: RecordSummary[];
  error?: string;
  q?: string;
}): string {
  const form = can(input.access, "records.write")
    ? `
    <section class="panel">
      <h2>Add item</h2>
      ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
      <form method="post" action="/libraries/${esc(input.library.id)}/items" class="capture">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        ${itemFields({ title: "", tags: "", notes: "", summaryRequired: true })}
        <button class="btn" type="submit">Add item</button>
      </form>
    </section>`
    : `<p class="hint">Read-only: you can open items but not change this library.</p>`;

  const list =
    input.records.length === 0
      ? `<p class="empty">No items yet.</p>`
      : `<ul class="cards">
          ${input.records
            .map(
              (row) => `
            <li>
              <a href="/items/${esc(row.id)}?library=${esc(input.library.id)}">
                <h3>${esc(row.title)}</h3>
                <p class="excerpt">${esc(row.excerpt) || "—"}</p>
                <p class="meta">${row.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("") || "no labels"}</p>
              </a>
            </li>`,
            )
            .join("")}
        </ul>`;

  const canWrite = can(input.access, "records.write");
  return layout({
    title: `${input.library.name} · Mpos`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: canWrite ? spreadsheetHead() : undefined,
    body: `
      <p class="hint">Library id: <code>${esc(input.library.id)}</code> — paste this when listing this library’s items.</p>
      ${form}
      <section>
        <h2>Items</h2>
        <form method="get" action="/libraries/${esc(input.library.id)}" class="search">
          <label class="sr-only" for="q">Filter</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Filter by name or label">
          <button class="btn secondary" type="submit">Filter</button>
        </form>
        ${list}
      </section>
      ${canWrite ? editorScripts() : ""}
    `,
  });
}

export function itemPage(input: {
  access: Access;
  csrf: string;
  record: RecordRow;
  library: LibraryRow;
  html: string;
}): string {
  const actions = can(input.access, "records.write")
    ? `<p class="actions">
         <a class="btn secondary" href="/items/${esc(input.record.id)}/edit">Edit</a>
         ${
           can(input.access, "records.delete")
             ? `<form method="post" action="/items/${esc(input.record.id)}/delete" class="inline"
                  onsubmit="return confirm('Delete this item?');">
                  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                  <button class="btn danger" type="submit">Delete</button>
                </form>`
             : ""
         }
       </p>`
    : "";

  return layout({
    title: `${input.record.title} · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    body: `
      <p><a href="/libraries/${esc(input.library.id)}">← ${esc(input.library.name)}</a></p>
      <article class="item">
        <h1>${esc(input.record.title)}</h1>
        <p class="meta">${input.record.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</p>
        <div class="prose">${input.html}</div>
        ${actions}
      </article>
    `,
  });
}

export function editPage(input: {
  access: Access;
  csrf: string;
  record: RecordRow;
  library: LibraryRow;
  error?: string;
}): string {
  return layout({
    title: `Edit ${input.record.title} · Mpos`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: spreadsheetHead(),
    body: `
      <p><a href="/items/${esc(input.record.id)}">← Item</a></p>
      <section class="panel">
        <h1>Edit item</h1>
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/items/${esc(input.record.id)}" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${itemFields({
            title: input.record.title,
            tags: input.record.tags.join(", "),
            notes: input.record.notes,
            summaryRequired: false,
          })}
          <button class="btn" type="submit">Save</button>
        </form>
      </section>
      ${editorScripts()}
    `,
  });
}

export function errorPage(message: string): string {
  return layout({
    title: "Error · Mpos",
    body: `<p class="error">${esc(message)}</p><p><a href="/">Libraries</a></p>`,
  });
}
