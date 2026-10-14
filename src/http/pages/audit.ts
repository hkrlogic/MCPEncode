/** Settings → Audit log: read-only list of audit events, newest first. */
import type { Access } from "../../auth/rbac.ts";
import type { AuditLogRow } from "../../db/audit.ts";
import { esc, layout, type AppShell } from "./layout.ts";

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function auditPage(input: {
  access: Access;
  csrf: string;
  shell: Pick<AppShell, "libraries" | "orphans" | "csrf" | "canAddLibrary" | "username" | "roleLabel" | "showAccounts">;
  rows: AuditLogRow[];
  page: number;
  hasMore: boolean;
  /** Libraries this person may filter by. Empty: nothing to show. */
  libraries: { id: string; name: string }[];
  libraryId?: string;
  /** True for a Site admin, who sees every event. */
  all: boolean;
}): string {
  const shell: AppShell = { ...input.shell, settingsMode: true, settingsActive: "audit" };
  const link = (page: number) => {
    const params = new URLSearchParams();
    if (input.libraryId) params.set("library", input.libraryId);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return esc(query ? `/audit?${query}` : "/audit");
  };
  const filter =
    input.libraries.length > 0
      ? `<form class="audit-filter" method="get" action="/audit">
          <label>Library
            <select name="library">
              ${input.all ? `<option value="">All libraries</option>` : `<option value="">All my libraries</option>`}
              ${input.libraries
                .map(
                  (row) =>
                    `<option value="${esc(row.id)}"${row.id === input.libraryId ? " selected" : ""}>${esc(row.name)}</option>`,
                )
                .join("")}
            </select>
          </label>
          <button class="btn secondary" type="submit">Show</button>
        </form>`
      : "";
  const table =
    input.rows.length === 0
      ? `<p class="empty">${
          input.libraries.length === 0 && !input.all
            ? "You are not a Publisher on any library, so there is no audit log to show."
            : "No audit events yet."
        }</p>`
      : `<table class="audit-table">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Library</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            ${input.rows
              .map(
                (row) => `<tr>
              <td>${esc(when(row.created_at))}</td>
              <td>${esc(row.actor)}</td>
              <td><code>${esc(row.tool)}</code></td>
              <td>${row.library_id ? `<a href="/libraries/${esc(row.library_id)}">${esc(row.library_name ?? "(deleted)")}</a>` : "—"}</td>
              <td>${row.success ? "OK" : "Failed"}</td>
              <td class="audit-detail">${esc(row.detail.length > 160 ? `${row.detail.slice(0, 160)}…` : row.detail)}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>`;
  const pager =
    input.page > 1 || input.hasMore
      ? `<nav class="pager" aria-label="Audit log pages">
          ${input.page > 1 ? `<a class="btn secondary" href="${link(input.page - 1)}">Newer</a>` : ""}
          <span class="hint">Page ${input.page}</span>
          ${input.hasMore ? `<a class="btn secondary" href="${link(input.page + 1)}">Older</a>` : ""}
        </nav>`
      : "";
  return layout({
    title: "Audit log · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="users-page">
        <header class="users-head">
          <div class="users-head-copy">
            <h1>Audit log</h1>
            <p class="hint">${
              input.all
                ? "Every recorded action: sign-ins to apps, edits, publishes, access changes and MCP tool calls."
                : "Recorded actions in the libraries where you are a Publisher."
            } Read-only.</p>
          </div>
        </header>
        ${filter}
        ${table}
        ${pager}
      </div>
    `,
  });
}
