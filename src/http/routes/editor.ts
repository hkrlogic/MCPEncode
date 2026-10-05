/** Markdown preview and HTML→markdown conversion for the editor. */
import express from "express";
import { can } from "../../auth/rbac.ts";
import { htmlToMarkdown, renderMarkdown } from "../../markdown/render.ts";
import { formString, requireCsrf, sessionAccess } from "../helpers.ts";
import type { AppRouteContext } from "./context.ts";

export function registerEditorRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config } = ctx;

  app.post("/preview", express.json({ limit: "200kb" }), async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const markdown = formString(req.body, "markdown") || (req.body?.markdown as string) || "";
    const html = await renderMarkdown(typeof markdown === "string" ? markdown : "");
    res.json({ html });
  });

  app.post("/convert-html", express.json({ limit: "200kb" }), async (req, res) => {
    const access = await sessionAccess(req, config);
    if (!access || !requireCsrf(req, access.csrf) || !can(access, "records.write")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    res.json({ markdown: htmlToMarkdown(html) });
  });
}
