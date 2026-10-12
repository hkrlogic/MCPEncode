/** Settings → Apps: remote https callback hosts of hosted MCP apps, approved by a site admin. */
import type { Access } from "../../auth/rbac.ts";
import type { CallbackHostRecord } from "../../auth/idp-store.ts";
import { confirmText, esc, layout, type AppShell } from "./layout.ts";

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
}

function decisionForm(csrf: string, host: string, decision: "approve" | "deny" | "revoke", label: string, confirm?: string): string {
  return `<form method="post" action="/apps/decide"${confirm ? ` data-confirm="${confirmText(confirm)}"` : ""}>
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="host" value="${esc(host)}">
      <input type="hidden" name="decision" value="${decision}">
      <button type="submit" class="btn${decision === "approve" ? "" : " secondary"}">${esc(label)}</button>
    </form>`;
}

export function appsPage(input: {
  access: Access;
  csrf: string;
  shell: Pick<AppShell, "libraries" | "orphans" | "csrf" | "canAddLibrary" | "username" | "roleLabel" | "showAccounts">;
  hosts: CallbackHostRecord[];
  envHosts: string[];
  /** False with AUTH_MODE=oidc: the external identity provider decides callbacks. */
  local: boolean;
  notice?: string;
  error?: string;
}): string {
  const shell: AppShell = { ...input.shell, showAccounts: true, settingsMode: true, settingsActive: "apps" };
  const flash = input.error
    ? `<p class="error" role="alert">${esc(input.error)}</p>`
    : input.notice
      ? `<p class="notice" role="status">${esc(input.notice)}</p>`
      : "";
  const section = (title: string, rows: CallbackHostRecord[], actions: (row: CallbackHostRecord) => string) =>
    rows.length === 0
      ? ""
      : `<h2>${esc(title)}</h2>
         <ul class="users-list apps-list">${rows
           .map(
             (row) => `<li class="user-row">
               <div class="user-identity">
                 <span class="user-name">${esc(row.host)}</span>
                 <span class="hint">${
                   row.sampleClientName ? `App says it is “${esc(row.sampleClientName)}” (unverified) · ` : ""
                 }first seen ${esc(when(row.firstSeen))} · last seen ${esc(when(row.lastSeen))}${
                   row.decidedAt ? ` · decided ${esc(when(row.decidedAt))} by ${esc(row.decidedBy ?? "")}` : ""
                 }</span>
               </div>
               <div class="user-actions">${actions(row)}</div>
             </li>`,
           )
           .join("")}</ul>`;
  const pending = input.hosts.filter((row) => row.status === "pending");
  const approved = input.hosts.filter((row) => row.status === "approved");
  const denied = input.hosts.filter((row) => row.status === "denied");
  const body = input.local
    ? `${flash}
      ${pending.length === 0 ? `<p class="empty">No apps are waiting for approval.</p>` : ""}
      ${section("Waiting for approval", pending, (row) =>
        [
          decisionForm(input.csrf, row.host, "approve", "Approve", `Approve ${row.host}?\n\nAny app with a callback on this host can then ask people here to sign in. Each person still sees the Allow page.`),
          decisionForm(input.csrf, row.host, "deny", "Deny"),
        ].join(""),
      )}
      ${section("Approved", approved, (row) =>
        decisionForm(input.csrf, row.host, "revoke", "Revoke", `Revoke ${row.host}?\n\nApps on this host are signed out (their refresh tokens end) and cannot sign in again unless you approve it.`),
      )}
      ${section("Denied", denied, (row) => decisionForm(input.csrf, row.host, "approve", "Approve"))}
      ${
        input.envHosts.length
          ? `<h2>From OAUTH_REDIRECT_HOSTS</h2><p class="hint">Always approved. Change the environment to remove one: ${input.envHosts
              .map((host) => `<code>${esc(host)}</code>`)
              .join(", ")}</p>`
          : ""
      }`
    : `<p class="hint">Sign-in for this deployment is an external identity provider. It decides which apps can sign in.</p>`;
  return layout({
    title: "Apps · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="users-page">
        <header class="users-head">
          <div class="users-head-copy">
            <h1>Apps</h1>
            <p class="hint">Hosted apps (for example a web chat connector) send people back to their own https address after sign-in. A site admin approves that address once. Desktop apps on this computer need no approval.</p>
          </div>
        </header>
        ${body}
      </div>
    `,
  });
}
