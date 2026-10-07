/** Add / view / edit item pages. */
import { can, type Access } from "../../auth/rbac.ts";
import type { ItemRow, LibraryRow } from "../../db/models.ts";
import { parseTableValues } from "../../items/table-proposal.ts";
import { itemFields, policyItemFields, procedureItemFields, schemaItemFields } from "./forms.ts";
import { writeModeLabel } from "./schema-choice.ts";
import {
  actionsMenuSummary,
  editorScripts,
  esc,
  layout,
  noticeMessage,
  onConfirm,
  publishDiff,
  spreadsheetHead,
  statusBadge,
  type AppShell,
} from "./layout.ts";

function pageShell(
  input: { csrf: string; access: Access; library: LibraryRow; shell?: AppShell },
): AppShell | undefined {
  if (input.shell) {
    return { ...input.shell, activeLibraryId: input.library.id, csrf: input.csrf };
  }
  return undefined;
}

export function addItemPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  error?: string;
  shell?: AppShell;
}): string {
  const kind = input.library.schema.starter;
  const tableName = input.library.schema.tableName;
  const fields =
    kind === "table"
      ? schemaItemFields({
          schema: input.library.schema,
          name: "",
          labels: "",
          summary: "",
          values: {},
        })
      : kind === "policy"
      ? policyItemFields({ name: "", labels: "", summary: "" })
      : kind === "procedure"
        ? procedureItemFields({ name: "", labels: "", summary: "" })
        : itemFields({ name: "", labels: "", body: "", summaryRequired: true });
  const liveHint =
    input.library.writeMode === "direct"
      ? `This library is ${writeModeLabel("direct")} — saving makes the item live immediately.`
      : "It stays Pending until you Publish.";
  const hint =
    kind === "table"
      ? `Each item is one row${tableName ? ` of ${esc(tableName)}` : ""}. ${liveHint}`
      : kind === "policy"
      ? `Every policy has the same fields: who owns it, when it is in force, and what it requires. ${liveHint}`
      : kind === "procedure"
        ? `Every procedure has the same fields: which policy it carries out, when to start, the steps, and who does them. ${liveHint}`
        : liveHint;
  return layout({
    title: `Add item · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell: pageShell(input),
    extraHead: kind === "general" ? spreadsheetHead() : undefined,
    body: `
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
  notice?: string;
  shell?: AppShell;
}): string {
  const canWrite = can(input.access, "records.write");
  const canDelete = can(input.access, "records.delete");
  const status = input.item.status;
  // Publish stays a primary button on Pending. Edit / gate moves / delete live in ⋯.
  const publishAction =
    canWrite && status === "draft"
      ? `<div class="gate-actions">
          <form method="post" action="/items/${esc(input.item.id)}/publish">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <button class="btn" type="submit">Publish</button>
          </form>
        </div>`
      : "";
  const menuItems = canWrite
    ? [
        `<a href="/items/${esc(input.item.id)}/edit">Edit</a>`,
        `<button type="button" data-open-sheet="publish-diff">Changes since published</button>`,
        status === "published"
          ? `<form method="post" action="/items/${esc(input.item.id)}/unpublish">
               <input type="hidden" name="csrf" value="${esc(input.csrf)}">
               <button type="submit">Unpublish</button>
             </form>`
          : "",
        status === "archived"
          ? `<form method="post" action="/items/${esc(input.item.id)}/restore">
               <input type="hidden" name="csrf" value="${esc(input.csrf)}">
               <button type="submit">Restore to Pending</button>
             </form>`
          : `<form method="post" action="/items/${esc(input.item.id)}/archive"
                 onsubmit="return confirm('Archive this item? It will leave Pending and Published.');">
               <input type="hidden" name="csrf" value="${esc(input.csrf)}">
               <button type="submit">Archive</button>
             </form>`,
        canDelete
          ? `<form class="menu-danger-sep" method="post" action="/items/${esc(input.item.id)}/delete"
                 onsubmit="${onConfirm(`Delete item “${input.item.name}”? This cannot be undone.`)}">
               <input type="hidden" name="csrf" value="${esc(input.csrf)}">
               <button class="menu-danger" type="submit">Delete</button>
             </form>`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const actions = menuItems
    ? `<details class="item-menu">
         ${actionsMenuSummary()}
         <div class="menu-list">
           ${menuItems}
         </div>
       </details>`
    : "";
  const labels = input.item.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");
  const flash = noticeMessage(input.notice, status);
  const diffSheet = canWrite
    ? `<dialog class="sheet" id="publish-diff" aria-labelledby="publish-diff-title">
         <div class="sheet-panel">
           <header class="sheet-head">
             <h2 id="publish-diff-title">Changes since published</h2>
             <button type="button" class="sheet-close" data-close-sheet aria-label="Close">
               <span aria-hidden="true">×</span>
             </button>
           </header>
           <div class="sheet-body">
             ${publishDiff(input.item, input.item.published_snapshot)}
           </div>
         </div>
       </dialog>
       <script>
         (function publishDiffSheet() {
           const sheet = document.getElementById("publish-diff");
           if (!(sheet instanceof HTMLDialogElement)) return;
           document.querySelectorAll('[data-open-sheet="publish-diff"]').forEach((btn) => {
             btn.addEventListener("click", () => {
               const menu = btn.closest("details.item-menu");
               if (menu) menu.open = false;
               sheet.showModal();
             });
           });
           sheet.querySelector("[data-close-sheet]")?.addEventListener("click", () => sheet.close());
           sheet.addEventListener("click", (event) => {
             if (event.target === sheet) sheet.close();
           });
         })();
       </script>`
    : "";

  return layout({
    title: `${input.item.name} · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell: pageShell(input),
    body: `
      <article class="item">
        <header class="item-head">
          <div class="item-head-bar">
            <p class="item-status">${statusBadge(status)}</p>
            ${actions}
          </div>
          <h1>${esc(input.item.name)}</h1>
          ${flash ? `<p class="notice" role="status">${esc(flash)}</p>` : ""}
          ${input.item.summary ? `<p class="lead">${esc(input.item.summary)}</p>` : ""}
          ${
            input.item.entity_key
              ? `<p class="meta">Entity key <code>${esc(input.item.entity_key)}</code></p>`
              : ""
          }
          ${labels ? `<p class="meta">${labels}</p>` : ""}
          ${publishAction}
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
      ${diffSheet}
    `,
  });
}

export function editPage(input: {
  access: Access;
  csrf: string;
  item: ItemRow;
  library: LibraryRow;
  error?: string;
  shell?: AppShell;
}): string {
  const publishBanner =
    input.library.writeMode === "direct"
      ? `<p class="notice" role="status">This library is ${esc(writeModeLabel("direct"))} — saving makes this item live for readers and agents.</p>`
      : input.item.status === "published"
        ? `<p class="notice" role="status">Saving moves this item to Pending and hides it from the kiosk until you Publish again.</p>`
        : input.item.status === "draft"
          ? `<p class="hint">This item is Pending. Publish from the item page when it is ready for the kiosk.</p>`
          : `<p class="hint">This item is Archived. Restore it before publishing.</p>`;
  return layout({
    title: `Edit ${input.item.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell: pageShell(input),
    extraHead: input.library.template === "general" ? spreadsheetHead() : undefined,
    body: `
      <p class="back"><a href="/items/${esc(input.item.id)}">Item</a></p>
      <section class="panel">
        <h1>Edit item</h1>
        ${publishBanner}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/items/${esc(input.item.id)}" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${
            input.library.schema.starter === "table"
              ? schemaItemFields({
                  schema: input.library.schema,
                  name: input.item.name,
                  labels: input.item.labels.join(", "),
                  summary: input.item.summary,
                  entityKey: input.item.entity_key ?? "",
                  values: parseTableValues(input.item.details) ?? {},
                })
              : input.library.template === "policy"
              ? policyItemFields({
                  name: input.item.name,
                  labels: input.item.labels.join(", "),
                  summary: input.item.summary,
                  entityKey: input.item.entity_key ?? "",
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
                    entityKey: input.item.entity_key ?? "",
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
                  entityKey: input.item.entity_key ?? "",
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
