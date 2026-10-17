/** Owner review queue and the per-item freshness block. */
import type { Access } from "../../auth/rbac.ts";
import type { ReviewQueueRow } from "../../db/freshness.ts";
import { REVIEW_DAYS, REVIEW_QUEUE_DAYS, isPastReview } from "../../db/freshness.ts";
import type { LibraryRow } from "../../db/models.ts";
import { esc, layout, type AppShell } from "./layout.ts";

function stillAccurateForm(itemId: string, csrf: string, back: "queue" | "item"): string {
  return `<form method="post" action="/items/${esc(itemId)}/still-accurate" class="inline-form">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="back" value="${back}">
      <button class="btn secondary" type="submit">Still accurate</button>
    </form>`;
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

const NOTICES: Record<string, string> = {
  confirmed: "Confirmed. The review-by date moved forward; the content and its version did not change.",
};

export function reviewQueuePage(input: {
  access: Access;
  csrf: string;
  library: LibraryRow;
  queue: ReviewQueueRow[];
  notice?: string;
  shell?: AppShell;
}): string {
  const lib = input.library;
  const notice = input.notice && NOTICES[input.notice] ? `<p class="notice" role="status">${esc(NOTICES[input.notice])}</p>` : "";
  const rows = input.queue
    .map(
      (row) => `<li class="review-row${row.overdue ? " is-overdue" : ""}">
        <div>
          <a href="/items/${esc(row.id)}">${esc(row.name)}</a>
          <p class="meta">${row.overdue ? `<span class="review-flag">Overdue</span> was due` : "Due"} ${esc(row.review_by)}${
            row.reviewed_at ? ` · last confirmed ${esc(when(row.reviewed_at))}${row.reviewed_by_name ? ` by ${esc(row.reviewed_by_name)}` : ""}` : ""
          }</p>
        </div>
        ${stillAccurateForm(row.id, input.csrf, "queue")}
      </li>`,
    )
    .join("");
  return layout({
    title: `Review · ${lib.name}`,
    csrf: input.csrf,
    access: input.access,
    library: { id: lib.id, name: lib.name },
    shell: input.shell,
    body: `
      <p class="back"><a href="/libraries/${esc(lib.id)}">${esc(lib.name)}</a></p>
      <section class="panel">
        <h1>Review queue</h1>
        ${notice}
        <p class="hint">Published items due for review within ${REVIEW_QUEUE_DAYS} days, or overdue. <strong>Still accurate</strong> re-confirms an item and moves its review-by date ${REVIEW_DAYS} days from today without changing its content or version. ${lib.template === "policy" || lib.template === "procedure" ? `Each publish sets it to ${REVIEW_DAYS} days out.` : "Set a date on an item page to track it here."}</p>
        ${rows ? `<ul class="review-queue">${rows}</ul>` : `<p class="empty">Nothing is due for review in the next ${REVIEW_QUEUE_DAYS} days.</p>`}
      </section>`,
  });
}

/** Item page: review-by line, plus Still accurate and a date editor for publishers. */
export function itemFreshnessBlock(input: {
  itemId: string;
  csrf: string;
  canWrite: boolean;
  live: boolean;
  reviewBy: string | null;
  reviewedAt: number | null;
  reviewedByName: string | null;
}): string {
  if (!input.reviewBy && !input.canWrite) return "";
  const overdue = isPastReview(input.reviewBy);
  const line = input.reviewBy
    ? `${overdue ? `<span class="review-flag">Past review</span> ` : ""}Review by ${esc(input.reviewBy)}${
        input.reviewedAt ? ` · last confirmed ${esc(when(input.reviewedAt))}${input.reviewedByName ? ` by ${esc(input.reviewedByName)}` : ""}` : ""
      }`
    : "No review-by date";
  if (!input.canWrite) return `<p class="meta freshness">${line}</p>`;
  return `<div class="freshness">
      <p class="meta">${line}</p>
      ${input.live ? stillAccurateForm(input.itemId, input.csrf, "item") : ""}
      <form method="post" action="/items/${esc(input.itemId)}/review-by" class="inline-form">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <label class="sr-only" for="review-by">Review by</label>
        <input id="review-by" type="date" name="review_by" value="${esc(input.reviewBy ?? "")}">
        <button class="btn ghost" type="submit">Set date</button>
      </form>
    </div>`;
}
