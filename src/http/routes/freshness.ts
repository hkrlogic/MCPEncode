/** Owner review queue, freshness settings, Still accurate, and review-by edits. */
import type express from "express";
import { can } from "../../auth/rbac.ts";
import { getItem, writeAudit } from "../../db/queries.ts";
import {
  REVIEW_DAYS_MAX,
  confirmStillAccurate,
  isIsoDate,
  reviewQueue,
  setLibraryFreshness,
  setReviewBy,
} from "../../db/freshness.ts";
import { formString, requireCsrf, sessionAccess } from "../helpers.ts";
import { errorPage } from "../pages.ts";
import { reviewQueuePage } from "../pages/freshness.ts";
import { loadAppShell } from "../shell.ts";
import type { AppRouteContext } from "./context.ts";
import { libraryContext } from "./libraries.ts";

export function registerFreshnessRoutes(app: express.Express, ctx: AppRouteContext): void {
  const { config, db } = ctx;

  /** Signed-in publisher on the library, or an error already sent. */
  async function publisherFor(req: express.Request, res: express.Response, libraryId: string, post: boolean) {
    const access = await sessionAccess(req, config);
    if (!access) {
      res.redirect("/login");
      return undefined;
    }
    if (post && !requireCsrf(req, access.csrf)) {
      res.status(403).send(errorPage("Invalid form token. Reload and try again."));
      return undefined;
    }
    const ctxLib = await libraryContext(db, libraryId, access);
    if (!ctxLib || "orphan" in ctxLib || !can(ctxLib.libraryAccess, "records.write")) {
      res.status(403).send(errorPage("Only publishers on this library can review items."));
      return undefined;
    }
    return { access, library: ctxLib.library, libraryAccess: ctxLib.libraryAccess };
  }

  app.get("/libraries/:id/review", async (req, res) => {
    const ok = await publisherFor(req, res, req.params.id, false);
    if (!ok) return;
    const shell = await loadAppShell(db, ok.access);
    res.send(
      reviewQueuePage({
        access: ok.libraryAccess,
        csrf: ok.access.csrf,
        library: ok.library,
        queue: await reviewQueue(db, ok.library.id),
        notice: typeof req.query.notice === "string" ? req.query.notice : undefined,
        shell: { ...shell, activeLibraryId: ok.library.id },
      }),
    );
  });

  app.post("/libraries/:id/freshness", async (req, res) => {
    const ok = await publisherFor(req, res, req.params.id, true);
    if (!ok) return;
    const raw = formString(req.body, "review_days").trim();
    if (raw !== "" && !(/^\d{1,4}$/.test(raw) && Number(raw) <= REVIEW_DAYS_MAX)) {
      res.redirect(`/libraries/${ok.library.id}/review?notice=invalid`);
      return;
    }
    const reviewDays = raw === "" ? null : Number(raw);
    const strict = formString(req.body, "strict_freshness") === "on";
    const saved = await setLibraryFreshness(db, ok.library.id, { reviewDays, strict }, ok.access.sub);
    await writeAudit(db, {
      actorSub: ok.access.sub,
      tool: "ui.set_freshness",
      success: saved,
      libraryId: ok.library.id,
      detail: `${ok.library.id}:review_days=${reviewDays ?? "default"}:strict=${strict}`,
    });
    res.redirect(`/libraries/${ok.library.id}/review?notice=saved`);
  });

  app.post("/items/:id/still-accurate", async (req, res) => {
    const item = await getItem(db, req.params.id, { publishedOnly: false });
    if (!item) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const ok = await publisherFor(req, res, item.library_id, true);
    if (!ok) return;
    const result = await confirmStillAccurate(db, ok.library, item.id, ok.access.sub);
    await writeAudit(db, {
      actorSub: ok.access.sub,
      tool: "ui.still_accurate",
      success: Boolean(result),
      libraryId: ok.library.id,
      detail: result ? `${item.id}:review_by=${result.reviewBy}` : item.id,
    });
    if (!result) {
      res.status(400).send(errorPage("Only a published item can be confirmed as still accurate."));
      return;
    }
    res.redirect(
      formString(req.body, "back") === "queue"
        ? `/libraries/${ok.library.id}/review?notice=confirmed`
        : `/items/${item.id}?notice=confirmed`,
    );
  });

  app.post("/items/:id/review-by", async (req, res) => {
    const item = await getItem(db, req.params.id, { publishedOnly: false });
    if (!item) {
      res.status(404).send(errorPage("Item not found."));
      return;
    }
    const ok = await publisherFor(req, res, item.library_id, true);
    if (!ok) return;
    const raw = formString(req.body, "review_by").trim();
    if (raw !== "" && !isIsoDate(raw)) {
      res.status(400).send(errorPage("Review by must be a date (YYYY-MM-DD), or empty to clear it."));
      return;
    }
    const saved = await setReviewBy(db, ok.library.id, item.id, raw || null);
    await writeAudit(db, {
      actorSub: ok.access.sub,
      tool: "ui.set_review_by",
      success: saved,
      libraryId: ok.library.id,
      detail: `${item.id}:review_by=${raw || "none"}`,
    });
    res.redirect(`/items/${item.id}?notice=review_by`);
  });
}
