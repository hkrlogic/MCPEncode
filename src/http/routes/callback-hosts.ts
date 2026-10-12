/** Settings → Apps: SA approves, denies or revokes hosted apps' callback hosts. */
import type express from "express";
import { can } from "../../auth/rbac.ts";
import { appsPage } from "../pages/apps.ts";
import { errorPage } from "../pages/login.ts";
import { formString, requireCsrf, sessionAccess } from "../helpers.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";

const NOTICES: Record<string, string> = {
  approve: "Approved. The app can finish signing in now; the person may need to start again from the app.",
  deny: "Denied. Apps on that host cannot sign in.",
  revoke: "Revoked. Apps on that host were signed out and cannot sign in again unless you approve it.",
};

export function registerCallbackHostRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  app.get("/apps", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage")) {
      res.status(403).send(errorPage("Only a site admin can approve apps."));
      return;
    }
    const listed = ctx.callbackHosts ? await ctx.callbackHosts.list() : { hosts: [], envHosts: [] };
    const flag = typeof req.query.notice === "string" ? req.query.notice : "";
    res.setHeader("Cache-Control", "no-store");
    res.send(
      appsPage({
        access,
        csrf: access.csrf,
        shell: await loadAppShell(db, access),
        hosts: listed.hosts,
        envHosts: listed.envHosts,
        local: Boolean(ctx.callbackHosts),
        notice: NOTICES[flag],
      }),
    );
  });

  app.post("/apps/decide", async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return;
    }
    if (!can(access, "accounts.manage") || !ctx.callbackHosts) {
      res.status(403).send(errorPage("Only a site admin can approve apps."));
      return;
    }
    if (!requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("That form expired. Reload and try again."));
      return;
    }
    const decision = formString(req.body, "decision");
    if (decision !== "approve" && decision !== "deny" && decision !== "revoke") {
      res.status(400).send(errorPage("Unknown decision."));
      return;
    }
    const result = await ctx.callbackHosts.decide({ host: formString(req.body, "host"), decision, by: access.sub });
    if (!result.ok) {
      res.status(400).send(errorPage(result.message));
      return;
    }
    res.redirect(`/apps?notice=${decision}`);
  });
}
