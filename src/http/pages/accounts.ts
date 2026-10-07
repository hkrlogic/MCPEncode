/** People who can sign in. Subjects from this list are granted on a library. */
import type { Access } from "../../auth/rbac.ts";
import type { Account } from "../../auth/accounts.ts";
import { esc, layout, onConfirm, type AppShell } from "./layout.ts";

export function accountsPage(input: {
  access: Access;
  csrf: string;
  shell: Pick<AppShell, "libraries" | "orphans" | "csrf" | "canAddLibrary">;
  accounts: Account[];
  /** Built-in sign-in. An external identity provider does not use this list. */
  local: boolean;
  error?: string;
  username?: string;
  created?: string;
  notice?: string;
}): string {
  const shell: AppShell = { ...input.shell, showAccounts: true };
  const rows = input.accounts
    .map((account) => {
      const role = account.role === "sa" ? "SA" : "Reader";
      const status = account.disabled ? " · Disabled" : "";
      const resetId = `reset-${account.id}`;
      const self = account.id === input.access.sub;
      return `
        <li class="access-person account-row">
          <div class="access-person-main">
            <span class="access-person-name">${esc(account.username)}</span>
            <span class="access-person-role">${role}${status}</span>
          </div>
          <div class="account-actions">
            ${
              account.disabled
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
              account.disabled
                ? ""
                : `<details class="account-reset">
                     <summary class="btn secondary">Reset password</summary>
                     <form method="post" action="/accounts/${esc(account.id)}/password" class="capture" id="${esc(resetId)}">
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
      ? `<p class="empty">No accounts yet.</p>`
      : `<ul class="access-list account-list">${rows}</ul>`;
  const form = input.local
    ? `
      <form class="capture" method="post" action="/accounts">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
        ${input.created ? `<p class="notice" role="status">Created ${esc(input.created)}. Tell them the password. It cannot be shown again.</p>` : ""}
        ${input.notice ? `<p class="notice" role="status">${esc(input.notice)}</p>` : ""}
        <label>Username
          <input name="username" autocomplete="off" required maxlength="64" value="${esc(input.username ?? "")}">
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="new-password" required>
        </label>
        <label>Role
          <select name="role">
            <option value="readonly">Reader — only libraries they are granted</option>
            <option value="sa">SA — manage accounts and every library</option>
          </select>
        </label>
        <button class="btn" type="submit">Create account</button>
      </form>`
    : `<p class="hint">Sign-in for this deployment is an external identity provider. Create people there, then grant their subject on a library.</p>`;

  return layout({
    title: "Accounts · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="library-view">
        <header class="library-head">
          <div>
            <h1>Accounts</h1>
            <p class="hint">People who can sign in. Grant them on a library as a reader or a publisher. SA can open every library without being listed.</p>
          </div>
        </header>
        ${form}
        ${input.local ? list : ""}
      </div>
    `,
  });
}
