/** Settings hub — same shell as libraries, with menu items on the left. */
import type { Access } from "../../auth/rbac.ts";
import { esc, layout, type AppShell } from "./layout.ts";

export function settingsPage(input: {
  access: Access;
  csrf: string;
  shell: Pick<
    AppShell,
    "libraries" | "orphans" | "csrf" | "canAddLibrary" | "username" | "roleLabel" | "showAccounts"
  >;
}): string {
  const shell: AppShell = {
    ...input.shell,
    settingsMode: true,
  };
  const name = input.shell.username?.trim() || "Signed in";
  const role = input.shell.roleLabel?.trim() || "";
  const accountsHint = input.shell.showAccounts
    ? `<p class="hint">Choose Accounts on the left to manage who can sign in.</p>`
    : `<p class="hint">Library access is managed inside each library.</p>`;

  return layout({
    title: "Settings · MCPEncode",
    csrf: input.csrf,
    access: input.access,
    shell,
    body: `
      <div class="users-page">
        <header class="users-head">
          <div class="users-head-copy">
            <h1>Settings</h1>
            <p class="hint">Signed in as ${esc(name)}${role ? ` · ${esc(role)}` : ""}.</p>
          </div>
        </header>
        ${accountsHint}
        <p class="empty-action"><a class="btn secondary" href="/logout">Sign out</a></p>
      </div>
    `,
  });
}
