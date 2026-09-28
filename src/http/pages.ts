import { can, type Access } from "../auth/rbac.ts";
import type { LibraryRow, ItemRow, ItemSummary } from "../db/queries.ts";
import {
  EMPTY_TABLE,
  splitSummaryAndTable,
  tableToSheetData,
  type MdTable,
} from "../markdown/table.ts";

function libraryKind(template: LibraryRow["template"]): string {
  if (template === "policy") return "Policy";
  if (template === "procedure") return "Procedure";
  return "General";
}

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
      <textarea id="body" name="body" class="sr-only" maxlength="50000"></textarea>
      <div class="preview" id="preview" aria-live="polite"><p class="hint">Table preview</p></div>
    </div>
  `;
}

function descriptionMarkup(description: string): string {
  return `
    <div class="section section-data">
      <label for="description">Body</label>
      <p class="hint">Primary place to paste this item. Markdown is fine. The summary above is only the one-liner search shows.</p>
      <div class="editor">
        <textarea id="description" name="description" rows="18" maxlength="50000"
          placeholder="Paste the item here.">${esc(description)}</textarea>
        <div class="preview" id="description-preview" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function captureEditor(body: string, summaryRequired: boolean): string {
  const split = splitSummaryAndTable(body);
  return `${summaryField(split.summary, summaryRequired)}${descriptionMarkup(split.description)}${tableMarkup(split.table ?? EMPTY_TABLE)}`;
}

function itemFields(input: { name: string; labels: string; body: string; summaryRequired: boolean }): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="ops, poc" autocomplete="off">
          </label>
        </div>
        ${captureEditor(input.body, input.summaryRequired)}
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
            <option value="general">General</option>
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
      ? `<p class="empty">No libraries yet.</p>`
      : `<ul class="cards">
          ${input.libraries
            .map(
              (row) => `
            <li>
              <a href="/libraries/${esc(row.id)}">
                <p class="kicker">${libraryKind(row.template)}</p>
                <h2>${esc(row.name)}</h2>
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
      <div class="library-view">
        <header class="library-head">
          <h1>Libraries</h1>
          ${form}
        </header>
        ${list}
      </div>
    `,
  });
}

export function libraryPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  items: ItemSummary[];
  error?: string;
  q?: string;
}): string {
  const countLabel = input.items.length === 1 ? "1 item" : `${input.items.length} items`;
  const list =
    input.items.length === 0
      ? `<p class="empty">${input.q ? "No items match that search." : "No items yet."}</p>`
      : `<ul class="item-list">
          ${input.items
            .map((row) => {
              const labels = row.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");
              return `
            <li>
              <a href="/items/${esc(row.id)}?library=${esc(input.library.id)}">
                <span class="item-name">${esc(row.name)}</span>
                ${row.summary ? `<span class="excerpt">${esc(row.summary)}</span>` : ""}
                ${labels ? `<span class="item-labels">${labels}</span>` : ""}
              </a>
            </li>`;
            })
            .join("")}
        </ul>`;

  const canWrite = can(input.access, "records.write");
  const addLink = canWrite
    ? `<a class="btn" href="/libraries/${esc(input.library.id)}/items/new">Add item</a>`
    : "";
  const deleteLibrary = can(input.access, "records.delete")
    ? `<details class="item-menu">
         <summary>Actions</summary>
         <div class="menu-list">
           ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
           <form method="post" action="/libraries/${esc(input.library.id)}/delete"
                onsubmit="return confirm('Delete this library and every item in it?');">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <button class="menu-danger" type="submit">Delete library</button>
           </form>
         </div>
       </details>`
    : "";
  return layout({
    title: `${input.library.name} · Mpos`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            <p class="kicker">${libraryKind(input.library.template)}</p>
            <h1>${esc(input.library.name)}</h1>
          </div>
          <div class="head-actions">
            ${addLink}
            ${deleteLibrary}
          </div>
        </header>
        <form method="get" action="/libraries/${esc(input.library.id)}" class="search" role="search">
          <label class="sr-only" for="q">Search items</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Search items" autocomplete="off" autofocus>
          <button type="submit">Search</button>
        </form>
        <section class="library-items" aria-labelledby="items-heading">
          <div class="section-row">
            <h2 id="items-heading" class="sr-only">Items</h2>
            <p class="count">${countLabel}</p>
          </div>
          ${list}
        </section>
        ${!can(input.access, "records.delete") && input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
      </div>
    `,
  });
}

function policyItemFields(input: {
  name: string;
  labels: string;
  summary: string;
  owner?: string;
  approvedBy?: string;
  version?: string;
  effectiveDate?: string;
  reviewDate?: string;
  purpose?: string;
  scope?: string;
  policy?: string;
  responsibilities?: string;
  exceptions?: string;
  references?: string;
}): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="remote, access" autocomplete="off">
          </label>
        </div>
        <label>Summary
          <input name="summary" required maxlength="160" value="${esc(input.summary)}"
            placeholder="One line. This is what search shows." autocomplete="off">
        </label>
        <fieldset class="policy-group">
          <legend>Document control</legend>
          <div class="row">
            <label>Owner
              <input name="owner" required maxlength="200" value="${esc(input.owner ?? "")}" autocomplete="off" placeholder="Role accountable for this policy">
            </label>
            <label>Approved by
              <input name="approved_by" maxlength="200" value="${esc(input.approvedBy ?? "")}" autocomplete="off" placeholder="Who signed it">
            </label>
          </div>
          <label>Version
            <input name="version" required maxlength="20" value="${esc(input.version || "1.0")}" autocomplete="off" placeholder="1.0">
          </label>
          <div class="row">
            <label>Effective date
              <input name="effective_date" type="date" required value="${esc(input.effectiveDate ?? "")}">
            </label>
            <label>Review date
              <input name="review_date" type="date" required value="${esc(input.reviewDate ?? "")}">
            </label>
          </div>
        </fieldset>
        <fieldset class="policy-group">
          <legend>Policy</legend>
          <label>Purpose
            <textarea name="purpose" required maxlength="8000" rows="4" placeholder="Why this policy exists.">${esc(input.purpose ?? "")}</textarea>
          </label>
          <label>Scope
            <textarea name="scope" required maxlength="8000" rows="4" placeholder="Who and what it covers.">${esc(input.scope ?? "")}</textarea>
          </label>
          <label>Policy
            <textarea name="policy" required maxlength="20000" rows="8" placeholder="The requirement. What people must do.">${esc(input.policy ?? "")}</textarea>
          </label>
          <label>Responsibilities
            <textarea name="responsibilities" maxlength="12000" rows="4" placeholder="Who carries it out. Optional.">${esc(input.responsibilities ?? "")}</textarea>
          </label>
          <label>Exceptions
            <textarea name="exceptions" maxlength="8000" rows="3" placeholder="How someone asks for an exception. Optional.">${esc(input.exceptions ?? "")}</textarea>
          </label>
          <label>References
            <textarea name="references" maxlength="8000" rows="3" placeholder="Related policies or standards. Optional.">${esc(input.references ?? "")}</textarea>
          </label>
        </fieldset>
  `;
}

function procedureItemFields(input: {
  name: string;
  labels: string;
  summary: string;
  owner?: string;
  relatedPolicy?: string;
  whenToUse?: string;
  steps?: string;
  who?: string;
}): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="visitor, lobby" autocomplete="off">
          </label>
        </div>
        <label>Summary
          <input name="summary" required maxlength="160" value="${esc(input.summary)}"
            placeholder="One line. This is what search shows." autocomplete="off">
        </label>
        <fieldset class="policy-group">
          <legend>Procedure</legend>
          <div class="row">
            <label>Owner
              <input name="owner" required maxlength="200" value="${esc(input.owner ?? "")}" autocomplete="off" placeholder="Role accountable for these steps">
            </label>
            <label>Related policy
              <input name="related_policy" required maxlength="200" value="${esc(input.relatedPolicy ?? "")}" autocomplete="off" placeholder="Name of the policy this carries out">
            </label>
          </div>
          <label>When to use it
            <textarea name="when_to_use" required maxlength="8000" rows="4" placeholder="The moment someone should start these steps.">${esc(input.whenToUse ?? "")}</textarea>
          </label>
          <label>Steps
            <textarea name="steps" required maxlength="20000" rows="10" placeholder="One step per line.">${esc(input.steps ?? "")}</textarea>
          </label>
          <label>Who does each step
            <textarea name="who" required maxlength="8000" rows="4" placeholder="Which role does which step.">${esc(input.who ?? "")}</textarea>
          </label>
        </fieldset>
  `;
}

export function addItemPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  error?: string;
}): string {
  const kind = input.library.template;
  const fields =
    kind === "policy"
      ? policyItemFields({ name: "", labels: "", summary: "" })
      : kind === "procedure"
        ? procedureItemFields({ name: "", labels: "", summary: "" })
        : itemFields({ name: "", labels: "", body: "", summaryRequired: true });
  const hint =
    kind === "policy"
      ? "Every policy has the same fields: who owns it, when it is in force, and what it requires."
      : kind === "procedure"
        ? "Every procedure has the same fields: which policy it carries out, when to start, the steps, and who does them."
        : "";
  return layout({
    title: `Add item · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: kind === "general" ? spreadsheetHead() : undefined,
    body: `
      <p><a href="/libraries/${esc(input.library.id)}">← ${esc(input.library.name)}</a></p>
      <section class="panel">
        <h1>Add item</h1>
        ${hint ? `<p class="hint">${hint}</p>` : ""}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/libraries/${esc(input.library.id)}/items" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${fields}
          <button class="btn" type="submit">Add item</button>
        </form>
      </section>
      ${kind === "general" ? editorScripts() : ""}
    `,
  });
}

export function itemPage(input: {
  access: Access;
  csrf: string;
  item: ItemRow;
  library: LibraryRow;
  html: string;
  control?: { label: string; value: string }[];
  sections?: { heading: string; html: string }[];
}): string {
  const actions = can(input.access, "records.write")
    ? `<details class="item-menu">
         <summary>Actions</summary>
         <div class="menu-list">
           <a href="/items/${esc(input.item.id)}/edit">Edit</a>
           ${
             can(input.access, "records.delete")
               ? `<form method="post" action="/items/${esc(input.item.id)}/delete"
                    onsubmit="return confirm('Delete this item?');">
                    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                    <button class="menu-danger" type="submit">Delete</button>
                  </form>`
               : ""
           }
         </div>
       </details>`
    : "";
  const labels = input.item.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");

  return layout({
    title: `${input.item.name} · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    body: `
      <p class="back"><a href="/libraries/${esc(input.library.id)}">${esc(input.library.name)}</a></p>
      <article class="item">
        <header class="item-head">
          <div>
            <p class="kicker">${libraryKind(input.library.template)}</p>
            <h1>${esc(input.item.name)}</h1>
            ${input.item.summary ? `<p class="lead">${esc(input.item.summary)}</p>` : ""}
            ${labels ? `<p class="meta">${labels}</p>` : ""}
          </div>
          ${actions}
        </header>
        ${
          input.control
            ? `<dl class="details">
                ${input.control.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join("")}
              </dl>
              ${(input.sections ?? [])
                .map((section) => `<h2>${esc(section.heading)}</h2><div class="prose">${section.html}</div>`)
                .join("")}`
            : `<div class="prose">${input.html}</div>`
        }
      </article>
    `,
  });
}

export function editPage(input: {
  access: Access;
  csrf: string;
  item: ItemRow;
  library: LibraryRow;
  error?: string;
}): string {
  return layout({
    title: `Edit ${input.item.name} · Mpos`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: input.library.template === "general" ? spreadsheetHead() : undefined,
    body: `
      <p><a href="/items/${esc(input.item.id)}">← Item</a></p>
      <section class="panel">
        <h1>Edit item</h1>
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/items/${esc(input.item.id)}" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${
            input.library.template === "policy"
              ? policyItemFields({
                  name: input.item.name,
                  labels: input.item.labels.join(", "),
                  summary: input.item.summary,
                  owner: input.item.policy?.owner,
                  approvedBy: input.item.policy?.approved_by,
                  version: input.item.policy?.version,
                  effectiveDate: input.item.policy?.effective_date,
                  reviewDate: input.item.policy?.review_date,
                  purpose: input.item.policy?.purpose,
                  scope: input.item.policy?.scope,
                  policy: input.item.policy?.policy,
                  responsibilities: input.item.policy?.responsibilities,
                  exceptions: input.item.policy?.exceptions,
                  references: input.item.policy?.references,
                })
              : input.library.template === "procedure"
                ? procedureItemFields({
                    name: input.item.name,
                    labels: input.item.labels.join(", "),
                    summary: input.item.summary,
                    owner: input.item.procedure?.owner,
                    relatedPolicy: input.item.procedure?.related_policy,
                    whenToUse: input.item.procedure?.when_to_use,
                    steps: input.item.procedure?.steps,
                    who: input.item.procedure?.who,
                  })
                : itemFields({
                  name: input.item.name,
                  labels: input.item.labels.join(", "),
                  body: input.item.body,
                  summaryRequired: false,
                })
          }
          <button class="btn" type="submit">Save</button>
        </form>
      </section>
      ${input.library.template === "general" ? editorScripts() : ""}
    `,
  });
}

export function errorPage(message: string): string {
  return layout({
    title: "Error · Mpos",
    body: `<p class="error">${esc(message)}</p><p><a href="/">Libraries</a></p>`,
  });
}
