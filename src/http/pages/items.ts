/** Add / view / edit item pages. */
import { can, type Access } from "../../auth/rbac.ts";
import type { ItemRow, LibraryRow } from "../../db/models.ts";
import type { SchemaField } from "../../items/library-schema.ts";
import { labeledItemData } from "../../markdown/render.ts";
import {
  itemFields,
  policyItemFields,
  procedureItemFields,
  structuredItemFields,
} from "./forms.ts";
import {
  editorScripts,
  esc,
  layout,
  libraryKind,
  noticeMessage,
  publishDiff,
  spreadsheetHead,
  statusBadge,
} from "./layout.ts";

export function addItemPage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  error?: string;
  /** When set, the published library schema drives the form. */
  schemaFields?: SchemaField[];
}): string {
  const kind = input.library.template;
  const structured = input.schemaFields && input.schemaFields.length > 0;
  const fields = structured
    ? structuredItemFields({
        name: "",
        labels: "",
        summary: "",
        schemaFields: input.schemaFields!,
        values: {},
      })
    : kind === "policy"
      ? policyItemFields({ name: "", labels: "", summary: "" })
      : kind === "procedure"
        ? procedureItemFields({ name: "", labels: "", summary: "" })
        : itemFields({ name: "", labels: "", body: "", summaryRequired: true });
  const hint = structured
    ? "This library uses a published schema. Field values are stored as typed rows."
    : kind === "policy"
      ? "Every policy has the same fields: who owns it, when it is in force, and what it requires."
      : kind === "procedure"
        ? "Every procedure has the same fields: which policy it carries out, when to start, the steps, and who does them."
        : "";
  return layout({
    title: `Add item · ${input.library.name}`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: !structured && kind === "general" ? spreadsheetHead() : undefined,
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
      ${!structured && kind === "general" ? editorScripts() : ""}
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
}): string {
  const canWrite = can(input.access, "records.write");
  const status = input.item.status;
  const kind = libraryKind(input.library.template);
  const gateForms = canWrite
    ? `
        <div class="gate-actions">
          ${
            status === "draft"
              ? `<form method="post" action="/items/${esc(input.item.id)}/publish">
                   <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                   <button class="btn" type="submit">Publish</button>
                 </form>`
              : ""
          }
          ${
            status === "published"
              ? `<form method="post" action="/items/${esc(input.item.id)}/unpublish">
                   <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                   <button class="btn secondary" type="submit">Unpublish</button>
                 </form>`
              : ""
          }
          ${
            status === "archived"
              ? `<form method="post" action="/items/${esc(input.item.id)}/restore">
                   <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                   <button class="btn secondary" type="submit">Restore to Pending</button>
                 </form>`
              : `<form method="post" action="/items/${esc(input.item.id)}/archive"
                     onsubmit="return confirm('Archive this item? It will leave Pending and Published.');">
                   <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                   <button class="btn secondary" type="submit">Archive</button>
                 </form>`
          }
        </div>`
    : "";
  const actions = canWrite
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
  const agentPreview = canWrite
    ? `<section class="gate-panel">
         <h2>Preview as agent</h2>
         <p class="hint">This is the wire text readers and the kiosk get when the item is published.</p>
         <pre class="agent-preview">${esc(labeledItemData(input.item))}</pre>
       </section>
       <section class="gate-panel">
         <h2>Changes since last published</h2>
         ${publishDiff(input.item, input.item.published_snapshot)}
       </section>`
    : "";

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
            ${kind ? `<p class="kicker">${esc(kind)}</p>` : ""}
            <p class="item-status">${statusBadge(status)}</p>
            <h1>${esc(input.item.name)}</h1>
            <p class="notice" role="status">${esc(noticeMessage(input.notice, status))}</p>
            ${input.item.summary ? `<p class="lead">${esc(input.item.summary)}</p>` : ""}
            ${labels ? `<p class="meta">${labels}</p>` : ""}
            ${gateForms}
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
        ${agentPreview}
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
  schemaFields?: SchemaField[];
  fieldValues?: Record<string, string | number | boolean>;
}): string {
  const publishBanner =
    input.item.status === "published"
      ? `<p class="notice" role="status">Saving moves this item to Pending and hides it from the kiosk until you Publish again.</p>`
      : input.item.status === "draft"
        ? `<p class="hint">This item is Pending. Publish from the item page when it is ready for the kiosk.</p>`
        : `<p class="hint">This item is Archived. Restore it before publishing.</p>`;
  const structured = input.schemaFields && input.schemaFields.length > 0;
  const fields = structured
    ? structuredItemFields({
        name: input.item.name,
        labels: input.item.labels.join(", "),
        summary: input.item.summary,
        schemaFields: input.schemaFields!,
        values: input.fieldValues ?? {},
      })
    : input.library.template === "policy"
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
          });
  return layout({
    title: `Edit ${input.item.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    library: input.library,
    extraHead: !structured && input.library.template === "general" ? spreadsheetHead() : undefined,
    body: `
      <p><a href="/items/${esc(input.item.id)}">← Item</a></p>
      <section class="panel">
        <h1>Edit item</h1>
        ${publishBanner}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/items/${esc(input.item.id)}" class="capture">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          ${fields}
          <button class="btn" type="submit">Save</button>
        </form>
      </section>
      ${!structured && input.library.template === "general" ? editorScripts() : ""}
    `,
  });
}
