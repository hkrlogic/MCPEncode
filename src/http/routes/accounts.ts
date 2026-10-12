/** Create and maintain sign-in accounts. SA only on the built-in identity provider. */
import type express from "express";
import { can } from "../../auth/rbac.ts";
import { accountStore } from "../../db/accounts.ts";
import type { AccountRole } from "../../auth/accounts.ts";
import { accountsPage } from "../pages/accounts.ts";
import { errorPage } from "../pages/login.ts";
import { settingsPage } from "../pages/settings.ts";
import { formString, requireCsrf, sessionAccess } from "../helpers.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";

export function registerAccountRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;
  const accounts = accountStore(db);

  app.get("/settings", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    // SA lands on Accounts — the main Settings item today.
    if (can(access, "accounts.manage")) {
      res.redirect("/accounts");
      return;
    }
    const shell = await loadAppShell(db, access);
    res.send(settingsPage({ access, csrf: access.csrf, shell }));
  });

  async function renderAccounts(
    access: NonNullable<Awaited<ReturnType<typeof sessionAccess>>>,
    extras: {
      error?: string;
      username?: string;
      created?: string;
      notice?: string;
      status?: number;
      saChecked?: boolean;
    } = {},
  ) {
    const shell = await loadAppShell(db, access);
    const local = config.authMode === "embedded";
    return {
      status: extras.status ?? 200,
      html: accountsPage({
        access,
        csrf: access.csrf,
        shell,
        accounts: local ? await accounts.list() : [],
        local,
        error: extras.error,
        username: extras.username,
        created: extras.created,
        notice: extras.notice,
        saChecked: extras.saChecked,
      }),
    };
  }

  app.get("/accounts", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage")) {
      res.status(403).send(errorPage("You cannot manage accounts with this account."));
      return;
    }
    const created =
      typeof req.query.created === "string" ? req.query.created.slice(0, 64) : undefined;
    const notice =
      typeof req.query.notice === "string" ? accountNotice(req.query.notice) : undefined;
    const page = await renderAccounts(access, { created, notice });
    res.status(page.status).send(page.html);
  });

  app.post("/accounts", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage") || config.authMode !== "embedded") {
      res.status(403).send(errorPage("You cannot manage accounts with this account."));
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("That form expired. Reload and try again."));
      return;
    }
    const username = formString(req.body, "username");
    const password = formString(req.body, "password");
    // App-level is SA on/off only. Unchecked → normal account (stored as readonly).
    const sa = formString(req.body, "sa") === "1";
    const role: AccountRole = sa ? "sa" : "readonly";
    const created = await accounts.create({ username, password, role });
    if (!created.ok) {
      const page = await renderAccounts(access, {
        username,
        saChecked: sa,
        error: created.message,
        status: 400,
      });
      res.status(page.status).send(page.html);
      return;
    }
    res.redirect(`/accounts?created=${encodeURIComponent(created.account.username)}`);
  });

  app.post("/accounts/:id/sa", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage") || config.authMode !== "embedded") {
      res.status(403).send(errorPage("You cannot manage accounts with this account."));
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("That form expired. Reload and try again."));
      return;
    }
    const sa = formString(req.body, "sa") === "1";
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const result = await accounts.setSa(id, sa);
    if (!result.ok) {
      const page = await renderAccounts(access, { error: result.message, status: 400 });
      res.status(page.status).send(page.html);
      return;
    }
    res.redirect(`/accounts?notice=${sa ? "sa-on" : "sa-off"}`);
  });

  app.post("/accounts/:id/password", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage") || config.authMode !== "embedded") {
      res.status(403).send(errorPage("You cannot manage accounts with this account."));
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("That form expired. Reload and try again."));
      return;
    }
    const result = await accounts.setPassword(req.params.id, formString(req.body, "password"));
    if (!result.ok) {
      const page = await renderAccounts(access, { error: result.message, status: 400 });
      res.status(page.status).send(page.html);
      return;
    }
    // A reset password ends every sign-in made with the old one.
    await ctx.revokeAccount?.(req.params.id);
    res.redirect("/accounts?notice=password");
  });

  app.post("/accounts/:id/disable", async (req, res) => {
    await setDisabled(req, res, true);
  });

  app.post("/accounts/:id/enable", async (req, res) => {
    await setDisabled(req, res, false);
  });

  async function setDisabled(
    req: express.Request,
    res: express.Response,
    disabled: boolean,
  ): Promise<void> {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage") || config.authMode !== "embedded") {
      res.status(403).send(errorPage("You cannot manage accounts with this account."));
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("That form expired. Reload and try again."));
      return;
    }
    if (disabled && req.params.id === access.sub) {
      const page = await renderAccounts(access, {
        error: "You cannot disable your own account.",
        status: 400,
      });
      res.status(page.status).send(page.html);
      return;
    }
    const result = await accounts.setDisabled(String(req.params.id), disabled);
    if (!result.ok) {
      const page = await renderAccounts(access, { error: result.message, status: 400 });
      res.status(page.status).send(page.html);
      return;
    }
    res.redirect(`/accounts?notice=${disabled ? "disabled" : "enabled"}`);
  }
}

/** Fixed copy for ?notice=. Query text is never echoed. */
function accountNotice(flag: string): string | undefined {
  if (flag === "password") return "Password updated. Tell them the new password. It cannot be shown again.";
  if (flag === "disabled") return "Account disabled. They cannot sign in until you enable it.";
  if (flag === "enabled") return "Account enabled. They can sign in again.";
  if (flag === "sa-on") return "SA turned on. They can manage accounts and open every library.";
  if (flag === "sa-off") return "SA turned off. Grant them on a library under Access if they still need one.";
  return undefined;
}
