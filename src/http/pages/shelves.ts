/** Add a shelf and search the libraries bonded to it. */
import { can, type Access } from "../../auth/rbac.ts";
import type { ShelfHit, ShelfRow } from "../../db/shelves.ts";
import { actionsMenuSummary, esc, layout, onConfirm, type AppShell } from "./layout.ts";

function shellFrom(input: {
  access: Access;
  csrf: string;
  shell: AppShell;
  addingShelf?: boolean;
  activeShelfId?: string;
}): AppShell {
  return {
    ...input.shell,
    csrf: input.csrf,
    addingShelf: input.addingShelf,
    activeShelfId: input.activeShelfId,
    canAddLibrary: can(input.access, "libraries.create"),
  };
}

export function addShelfPage(input: {
  access: Access;
  csrf: string;
  shell: AppShell;
  error?: string;
  name?: string;
}): string {
  return layout({
    title: "Add shelf · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell: shellFrom({ ...input, addingShelf: true }),
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            <h1>Add shelf</h1>
          </div>
        </header>
        <p class="hint">A shelf searches the libraries you put on it. It does not change Access, and it does not edit items.</p>
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <form method="post" action="/shelves" class="capture add-library-form">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <label>Shelf name
            <input name="name" required maxlength="200" autocomplete="off" placeholder="Facilities" value="${esc(input.name ?? "")}">
          </label>
          <button class="btn" type="submit">Add shelf</button>
        </form>
      </div>
    `,
  });
}

export function shelfPage(input: {
  access: Access;
  csrf: string;
  shell: AppShell;
  shelf: ShelfRow;
  libraries: { id: string; name: string }[];
  q?: string;
  hits?: ShelfHit[];
  notice?: string;
  error?: string;
}): string {
  const canManage = can(input.access, "libraries.create");
  const hits = input.hits;
  const results =
    hits == null
      ? `<p class="hint">Search published items across the libraries on this shelf.</p>`
      : hits.length === 0
        ? `<p class="empty">No published items matched.</p>`
        : `<ul class="item-list">
            ${hits
              .map(
                (hit) => `
              <li>
                <a class="item-link" href="/items/${esc(hit.itemId)}?library=${esc(hit.libraryId)}">
                  <span class="item-name-row">
                    <span class="item-name">${esc(hit.name)}</span>
                  </span>
                  <span class="excerpt">${esc(hit.summary)}</span>
                  <span class="item-labels"><span class="tag">${esc(hit.libraryName)}</span></span>
                </a>
              </li>`,
              )
              .join("")}
          </ul>`;
  const libraryLinks =
    input.libraries.length === 0
      ? `<p class="hint">No libraries on this shelf yet. Open a library and choose this shelf under Actions.</p>`
      : `<ul class="shelf-libraries">
          ${input.libraries
            .map(
              (library) =>
                `<li><a href="/libraries/${esc(library.id)}">${esc(library.name)}</a></li>`,
            )
            .join("")}
        </ul>`;
  const manage = canManage
    ? `<details class="item-menu">
         ${actionsMenuSummary()}
         <div class="menu-list">
           <form class="menu-form" method="post" action="/shelves/${esc(input.shelf.id)}/rename">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <label class="menu-field">
               <span class="sr-only">Shelf name</span>
               <input name="name" required maxlength="200" value="${esc(input.shelf.name)}" autocomplete="off">
             </label>
             <button type="submit">Rename shelf</button>
           </form>
           <form method="post" action="/shelves/${esc(input.shelf.id)}/delete"
                 onsubmit="${onConfirm(`Remove the shelf “${input.shelf.name}”? Libraries stay. They will no longer be searched together.`)}">
             <input type="hidden" name="csrf" value="${esc(input.csrf)}">
             <button class="menu-danger" type="submit">Remove shelf</button>
           </form>
         </div>
       </details>`
    : "";
  return layout({
    title: `${input.shelf.name} · MCPEncode`,
    csrf: input.csrf,
    access: input.access,
    shell: shellFrom({ ...input, activeShelfId: input.shelf.id }),
    body: `
      <div class="library-view">
        <header class="library-head">
          <div class="library-head-row">
            <h1 title="${esc(input.shelf.name)}">${esc(input.shelf.name)}</h1>
            <div class="head-actions">${manage}</div>
          </div>
        </header>
        <p class="hint">Bonded search. Hits are published items you can already read. Open an item in its library to change it.</p>
        ${input.notice ? `<p class="notice" role="status">${esc(input.notice)}</p>` : ""}
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        <h2 class="shelf-libraries-heading">Libraries</h2>
        ${libraryLinks}
        <form method="get" action="/shelves/${esc(input.shelf.id)}" class="search" role="search">
          <label class="sr-only" for="q">Search this shelf</label>
          <input id="q" name="q" value="${esc(input.q ?? "")}" placeholder="Search this shelf" autocomplete="off" required>
          <button type="submit">Search</button>
        </form>
        ${results}
      </div>
    `,
  });
}
