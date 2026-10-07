/** People who can sign in. Subjects from this list are granted on a library. */
import type { Access } from "../../auth/rbac.ts";
import type { Account } from "../../auth/accounts.ts";
import { esc, layout, onConfirm, type AppShell } from "./layout.ts";

function initial(username: string): string {
  const ch = username.trim().charAt(0);
  return (ch || "?").toUpperCase();
}

export function accountsPage(input: {
  access: Access;
  csrf: string;
  shell: Pick<
    AppShell,
    "libraries" | "orphans" | "csrf" | "canAddLibrary" | "username" | "roleLabel" | "showAccounts"
  >;
  accounts: Account[];
  /** Built-in sign-in. An external identity provider does not use this list. */
  local: boolean;
  error?: string;
  username?: string;
  created?: string;
  notice?: string;
}): string {
  const shell: AppShell = {
    ...input.shell,
    showAccounts: true,
    settingsMode: true,
    settingsActive: "accounts",
  };
  const flash =
    input.error
      ? `<p class="error" role="alert">${esc(input.error)}</p>`
      : input.created
        ? `<p class="notice" role="status">Created ${esc(input.created)}. Tell them the password. It cannot be shown again.</p>`
        : input.notice
          ? `<p class="notice" role="status">${esc(input.notice)}</p>`
          : "";

  const rows = input.accounts
    .map((account) => {
      const role = account.role === "sa" ? "SA" : "Reader";
      const roleClass = account.role === "sa" ? "user-badge-sa" : "user-badge-reader";
      const disabled = account.disabled;
      const self = account.id === input.access.sub;
      const resetId = `reset-${account.id}`;
      return `
        <li class="user-row${disabled ? " is-disabled" : ""}">
          <span class="user-avatar" aria-hidden="true">${esc(initial(account.username))}</span>
          <div class="user-identity">
            <span class="user-name">${esc(account.username)}</span>
            ${self ? `<span class="user-you">You</span>` : ""}
          </div>
          <span class="user-badge ${roleClass}">${role}</span>
          <span class="user-badge ${disabled ? "user-badge-off" : "user-badge-on"}">${
            disabled ? "Disabled" : "Active"
          }</span>
          <div class="user-actions">
            ${
              disabled
                ? `<form method="post" action="/accounts/${esc(account.id)}/enable">
                     <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                     <button type="submit" class="btn secondary">Enable</button>
                   </form>`
                : `<form method="post" action="/accounts/${esc(account.id)}/disable"
                       onsubmit="${onConfirm(
                         self
                           ? "Disable your own account? You will be signed out."
                           : `Disable ${account.username}? They cannot sign in until enabled.`,
                       )}">
                     <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                     <button type="submit" class="btn secondary"${self ? " disabled" : ""}>Disable</button>
                   </form>`
            }
            ${
              disabled
                ? ""
                : `<details class="user-reset">
                     <summary class="btn secondary">Reset password</summary>
                     <form method="post" action="/accounts/${esc(account.id)}/password" class="capture user-reset-form" id="${esc(resetId)}">
                       <input type="hidden" name="csrf" value="${esc(input.csrf)}">
                       <label>New password
                         <input name="password" type="password" autocomplete="new-password" required minlength="12">
                       </label>
                       <button class="btn" type="submit">Save password</button>
                     </form>
                   </details>`
            }
          </div>
        </li>`;
    })
    .join("");

  const list =
    input.accounts.length === 0
      ? `<div class="users-empty"><p class="empty">No users yet.</p></div>`
      : `
        <div class="users-panel">
          <div class="users-panel-head" aria-hidden="true">
            <span class="users-col-user">User</span>
            <span class="users-col-role">Role</span>
            <span class="users-col-status">Status</span>
            <span class="users-col-actions">Actions</span>
          </div>
          <ul class="users-list">${rows}</ul>
        </div>`;

  const addOpen = Boolean(input.error || input.username);
  const addControl = input.local
    ? `
      <details class="users-add"${addOpen ? " open" : ""}>
        <summary class="btn">Add user</summary>
        <form class="capture users-add-form" method="post" action="/accounts">
          <input type="hidden" name="csrf" value="${esc(input.csrf)}">
          <div class="users-add-grid">
            <label>Username
              <input name="username" autocomplete="off" required maxlength="64" value="${esc(input.username ?? "")}">
            </label>
            <label>Password
              <input name="password" type="password" autocomplete="new-password" required minlength="12">
            </label>
            <label>Role
              <select name="role">
                <option value="readonly">Reader — only libraries they are granted</option>
                <option value="sa">SA — manage accounts and every library</option>
              </select>
            </label>
          </div>
          <button class="btn" type="submit">Create user</button>
        </form>
      </details>`
    : "";
  const externalHint = input.local
    ? ""
    : `<p class="hint users-external">Sign-in for this deployment is an external identity provider. Create people there, then grant their subject on a library.</p>`;

  return layout({
    title: "Accounts · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="users-page">
        <header class="users-head">
          <div class="users-head-copy">
            <h1>Accounts</h1>
            <p class="hint">Users who can sign in. Grant them on a library as a reader or a publisher. SA can open every library without being listed.</p>
          </div>
          ${addControl}
        </header>
        ${flash}
        ${externalHint}
        ${input.local ? list : ""}
      </div>
    `,
  });
}
