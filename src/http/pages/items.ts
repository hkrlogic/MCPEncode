/** Add / view / edit item pages. */
import { can, type Access } from "../../auth/rbac.ts";
import type { ItemFileMeta } from "../../db/files.ts";
import type { ItemRow, LibraryRow } from "../../db/models.ts";
import { canRevertToPublished, revertPlan } from "../../db/queries.ts";
import { fileKindLabel, formatFileSize, MAX_FILES_PER_ITEM } from "../../items/files.ts";
import { isPlainGeneral } from "../../items/library-schema.ts";
import { valuesForSchemaEdit } from "../../items/table-proposal.ts";
import { itemFields, schemaItemFields } from "./forms.ts";
import { writeModeLabel } from "./schema-choice.ts";
import {
  actionsMenuSummary,
  editorScripts,
  esc,
  layout,
  itemReviewBlock,
  noticeMessage,
  onConfirm,
  publishDiff,
  spreadsheetHead,
  statusBadge,
  type AppShell,
} from "./layout.ts";

/** Confirm copy — revert replaces working edits; item stays Pending until Publish. */
const REVERT_CONFIRM =
  "Revert this item to the last published version? Your current edits will be replaced. The item will stay Pending until you Publish.";

/** After an accidental Publish, restore the prior seal; readers keep the current until Publish. */
const REVERT_PREVIOUS_CONFIRM =
  "Revert this item to the previous published version? The current published copy stays live for readers until you Publish again. The item will stay Pending until you Publish.";

/** Files sit under the sections. Publishers can add one; readers only see what is already there. */
function itemFilesSection(input: {
  access: Access;
  csrf: string;
  item: ItemRow;
  library: LibraryRow;
  files?: ItemFileMeta[];
}): string {
  const canWrite = can(input.access, "records.write");
  const files = input.files ?? [];
  if (!canWrite && files.length === 0) return "";
  const rows = files
    .map((file) => {
      const remove = canWrite
        ? `<form method="post" action="/items/${esc(input.item.id)}/files/${esc(file.id)}/delete"
               onsubmit="${onConfirm("Remove this file from the item?")}">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <button class="btn secondary" type="submit">Remove</button>
           </form>`
        : "";
      return `<li class="item-file">
        <p class="item-file-name">
          <a href="/items/${esc(input.item.id)}/files/${esc(file.id)}">${esc(file.name)}</a>
          <span class="item-file-meta">${esc(fileKindLabel(file.content_type))} · ${esc(formatFileSize(file.byte_size))}</span>
        </p>
        ${remove}
      </li>`;
    })
    .join("");
  const atCap = files.length >= MAX_FILES_PER_ITEM;
  const gateHint =
    canWrite &&
    input.library.writeMode === "reviewed" &&
    input.item.status === "published"
      ? `<p class="hint">Adding or removing a file moves this item to Pending until you Publish.</p>`
      : "";
  const form =
    canWrite && !atCap
      ? `<form class="file-add" method="post" action="/items/${esc(input.item.id)}/files" enctype="multipart/form-data">
           <input type="hidden" name="csrf" value="${esc(input.csrf)}">
           <label class="file-pick">Add a file
             <input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required>
           </label>
           <button class="btn" type="submit">Add file</button>
         </form>
         <p class="hint">PDF or image. Up to 10 MB. Five files on an item.</p>
         ${gateHint}`
      : canWrite && atCap
        ? `<p class="hint">This item has 5 files. Remove one to add another.</p>${gateHint}`
        : "";
  const list = rows ? `<ul class="item-file-list">${rows}</ul>` : "";
  return `<section class="item-files" aria-labelledby="item-files-heading">
    <h2 id="item-files-heading">Files</h2>
    ${list}
    ${form}
  </section>`;
}

function pageShell(
  input: { csrf: string; access: Access; library: LibraryRow; shell?: AppShell },
): AppShell | undefined {
  if (input.shell) {
    return { ...input.shell, activeLibraryId: input.library.id, csrf: input.csrf };
  }
  return undefined;
}

function usesSchemaForm(library: LibraryRow): boolean {
  return !isPlainGeneral(library.schema);
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
  const schemaForm = usesSchemaForm(input.library);
  const fields = schemaForm
    ? schemaItemFields({
        schema: input.library.schema,
        name: "",
        labels: "",
        summary: "",
        values: {},
      })
    : itemFields({ name: "", labels: "", body: "", summaryRequired: true });
  const liveHint =
    input.library.writeMode === "direct"
      ? `This library is ${writeModeLabel("direct")} — saving makes the item live immediately.`
      : "It stays Pending until you Publish.";
  const hint =
    kind === "table"
      ? `Each item is one row${tableName ? ` of ${esc(tableName)}` : ""}. ${liveHint}`
      : kind === "policy"
      ? `Fill the policy fields for this library. ${liveHint}`
      : kind === "procedure"
        ? `Fill the procedure fields for this library. ${liveHint}`
        : input.library.schema.custom
          ? `Fill the fields for this library. ${liveHint}`
          : liveHint;
  return layout({
    title: `Add item · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell: pageShell(input),
    extraHead: !schemaForm ? spreadsheetHead() : undefined,
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
      ${!schemaForm ? editorScripts() : ""}
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
  files?: ItemFileMeta[];
  notice?: string;
  shell?: AppShell;
}): string {
  const canWrite = can(input.access, "records.write");
  const canDelete = can(input.access, "records.delete");
  const status = input.item.status;
  // Revert: Pending edits vs current snapshot, or previous snapshot after an accidental Publish.
  const plan = revertPlan(input.item);
  const showRevert = canWrite && canRevertToPublished(input.item) && plan !== null;
  const revertLabel =
    plan?.kind === "previous" ? "Revert to previous published" : "Revert to published";
  const revertConfirm = plan?.kind === "previous" ? REVERT_PREVIOUS_CONFIRM : REVERT_CONFIRM;
  const revertForm = (className?: string) =>
    showRevert
      ? `<form${className ? ` class="${className}"` : ""} method="post" action="/items/${esc(input.item.id)}/revert-published"
           onsubmit="${onConfirm(revertConfirm)}">
           <input type="hidden" name="csrf" value="${esc(input.csrf)}">
           <button type="submit">${esc(revertLabel)}</button>
         </form>`
      : "";
  // Publish stays a primary button on Pending. Edit / gate moves / delete live in ⋯.
  const cancelConfirm = input.item.published_snapshot
    ? "Cancel this publish request? The item goes back to the last published version."
    : "Cancel this publish request? This item was never published, so it will move to Archives.";
  const publishAction =
    canWrite && status === "draft"
      ? `<div class="gate-actions">
          <form method="post" action="/items/${esc(input.item.id)}/publish">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <button class="btn" type="submit">Publish</button>
          </form>
          <form method="post" action="/items/${esc(input.item.id)}/cancel" onsubmit="${onConfirm(cancelConfirm)}">
            <input type="hidden" name="csrf" value="${esc(input.csrf)}">
            <button class="btn secondary" type="submit">Cancel</button>
          </form>
        </div>`
      : "";
  const exportLink = `<a href="/items/${esc(input.item.id)}/export.md">Export Markdown</a>`;
  const menuItems = [
    exportLink,
    ...(canWrite
      ? [
          `<a href="/items/${esc(input.item.id)}/edit">Edit</a>`,
          `<button type="button" data-open-sheet="publish-diff">Changes since published</button>`,
          revertForm(),
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
      : []),
  ]
    .filter(Boolean)
    .join("\n");
  const actions = `<details class="item-menu">
         ${actionsMenuSummary()}
         <div class="menu-list">
           ${menuItems}
         </div>
       </details>`;
  const labels = input.item.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");
  const flash = noticeMessage(input.notice, status);
  const review = itemReviewBlock(input.item, input.library.schema);
  const unlockHint =
    input.library.writeMode === "direct"
      ? `<p class="hint">In Review Unlock, each save refreshes the live snapshot and keeps the previous one for Revert.</p>`
      : "";
  const previousHint =
    plan?.kind === "previous"
      ? `<p class="hint">Working fields match what is published now. Revert restores the previous published copy into this item; readers keep the current published copy until you Publish.</p>`
      : "";
  // After accidental Publish, Diff vs current is empty — compare previous vs live instead.
  const diffBody =
    plan?.kind === "previous"
      ? publishDiff(input.item, input.item.previous_published_snapshot)
      : publishDiff(input.item, input.item.published_snapshot);
  const diffSheet = canWrite
    ? `<dialog class="sheet" id="publish-diff" aria-labelledby="publish-diff-title">
         <div class="sheet-panel">
           <header class="sheet-head">
             <h2 id="publish-diff-title">${
               plan?.kind === "previous" ? "Previous published" : "Changes since published"
             }</h2>
             <button type="button" class="sheet-close" data-close-sheet aria-label="Close">
               <span aria-hidden="true">×</span>
             </button>
           </header>
           <div class="sheet-body">
             ${unlockHint}
             ${previousHint}
             ${diffBody}
             ${
               showRevert
                 ? `<div class="sheet-actions">
                      ${revertForm("sheet-revert")}
                    </div>`
                 : ""
             }
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
            <div class="item-head-start">
              <p class="back"><a class="back-btn" href="/libraries/${esc(input.library.id)}" aria-label="Back to items"><svg class="back-btn-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5.5 8 12l6.5 6.5"/></svg></a></p>
              <p class="item-status">${statusBadge(status)}</p>
            </div>
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
        </header>
        ${review}
        ${publishAction}
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
        ${itemFilesSection(input)}
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
  const schemaForm = usesSchemaForm(input.library);
  return layout({
    title: `Edit ${input.item.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    shell: pageShell(input),
    extraHead: !schemaForm ? spreadsheetHead() : undefined,
    body: `
      <p class="back"><a href="/items/${esc(input.item.id)}">Item</a></p>
      <section class="panel">
        <h1>Edit item</h1>
        ${publishBanner}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/items/${esc(input.item.id)}" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${
            schemaForm
              ? schemaItemFields({
                  schema: input.library.schema,
                  name: input.item.name,
                  labels: input.item.labels.join(", "),
                  summary: input.item.summary,
                  entityKey: input.item.entity_key ?? "",
                  values: valuesForSchemaEdit(input.item, input.library.schema),
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
      ${!schemaForm ? editorScripts() : ""}
    `,
  });
}
