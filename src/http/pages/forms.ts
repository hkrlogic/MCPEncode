/** HTML form field builders for add/edit item pages. */
import {
  EMPTY_TABLE,
  splitSummaryAndTable,
  tableToSheetData,
  type MdTable,
} from "../../markdown/table.ts";
import { esc } from "./layout.ts";

export function summaryField(summary: string, required: boolean): string {
  return `
    <label>Summary
      <input name="summary" maxlength="160" ${required ? "required" : ""} value="${esc(summary)}"
        placeholder="One line. This is what search shows." autocomplete="off">
    </label>
  `;
}

export function tableMarkup(table: MdTable): string {
  return `
    <div class="section">
      <p class="sheet-label">Table</p>
      <p class="hint">Optional grid. Leave blank if you pasted the item above.</p>
      <div class="sheet-wrap">
        <div id="spreadsheet" data-table="${esc(JSON.stringify(tableToSheetData(table)))}"></div>
      </div>
      <textarea id="body" name="body" class="sr-only" maxlength="50000"></textarea>
      <div class="preview" id="preview" aria-live="polite"><p class="hint">Table preview</p></div>
    </div>
  `;
}

export function descriptionMarkup(description: string): string {
  return `
    <div class="section section-data">
      <label for="description">Body</label>
      <p class="hint">Primary place to paste this item. Markdown is fine. The summary above is only the one-liner search shows.</p>
      <div class="editor">
        <textarea id="description" name="description" rows="18" maxlength="50000"
          placeholder="Paste the item here.">${esc(description)}</textarea>
        <div class="preview" id="description-preview" aria-live="polite"></div>
      </div>
    </div>
  `;
}

export function captureEditor(body: string, summaryRequired: boolean): string {
  const split = splitSummaryAndTable(body);
  return `${summaryField(split.summary, summaryRequired)}${descriptionMarkup(split.description)}${tableMarkup(split.table ?? EMPTY_TABLE)}`;
}

export function itemFields(input: {
  name: string;
  labels: string;
  body: string;
  summaryRequired: boolean;
}): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="ops, poc" autocomplete="off">
          </label>
        </div>
        ${captureEditor(input.body, input.summaryRequired)}
  `;
}

export function policyItemFields(input: {
  name: string;
  labels: string;
  summary: string;
  owner?: string;
  approvedBy?: string;
  version?: string;
  effectiveDate?: string;
  reviewDate?: string;
  purpose?: string;
  scope?: string;
  policy?: string;
  responsibilities?: string;
  exceptions?: string;
  references?: string;
}): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="remote, access" autocomplete="off">
          </label>
        </div>
        <label>Summary
          <input name="summary" required maxlength="160" value="${esc(input.summary)}"
            placeholder="One line. This is what search shows." autocomplete="off">
        </label>
        <fieldset class="policy-group">
          <legend>Document control</legend>
          <div class="row">
            <label>Owner
              <input name="owner" required maxlength="200" value="${esc(input.owner ?? "")}" autocomplete="off" placeholder="Role accountable for this policy">
            </label>
            <label>Approved by
              <input name="approved_by" maxlength="200" value="${esc(input.approvedBy ?? "")}" autocomplete="off" placeholder="Who signed it">
            </label>
          </div>
          <label>Version
            <input name="version" required maxlength="20" value="${esc(input.version || "1.0")}" autocomplete="off" placeholder="1.0">
          </label>
          <div class="row">
            <label>Effective date
              <input name="effective_date" type="date" required value="${esc(input.effectiveDate ?? "")}">
            </label>
            <label>Review date
              <input name="review_date" type="date" required value="${esc(input.reviewDate ?? "")}">
            </label>
          </div>
        </fieldset>
        <fieldset class="policy-group">
          <legend>Policy</legend>
          <label>Purpose
            <textarea name="purpose" required maxlength="8000" rows="4" placeholder="Why this policy exists.">${esc(input.purpose ?? "")}</textarea>
          </label>
          <label>Scope
            <textarea name="scope" required maxlength="8000" rows="4" placeholder="Who and what it covers.">${esc(input.scope ?? "")}</textarea>
          </label>
          <label>Policy
            <textarea name="policy" required maxlength="20000" rows="8" placeholder="The requirement. What people must do.">${esc(input.policy ?? "")}</textarea>
          </label>
          <label>Responsibilities
            <textarea name="responsibilities" maxlength="12000" rows="4" placeholder="Who carries it out. Optional.">${esc(input.responsibilities ?? "")}</textarea>
          </label>
          <label>Exceptions
            <textarea name="exceptions" maxlength="8000" rows="3" placeholder="How someone asks for an exception. Optional.">${esc(input.exceptions ?? "")}</textarea>
          </label>
          <label>References
            <textarea name="references" maxlength="8000" rows="3" placeholder="Related policies or standards. Optional.">${esc(input.references ?? "")}</textarea>
          </label>
        </fieldset>
  `;
}

export function procedureItemFields(input: {
  name: string;
  labels: string;
  summary: string;
  owner?: string;
  relatedPolicy?: string;
  whenToUse?: string;
  steps?: string;
  who?: string;
}): string {
  return `
        <div class="row">
          <label>Name
            <input name="name" required maxlength="200" value="${esc(input.name)}" autocomplete="off">
          </label>
          <label>Labels
            <input name="labels" value="${esc(input.labels)}" placeholder="visitor, lobby" autocomplete="off">
          </label>
        </div>
        <label>Summary
          <input name="summary" required maxlength="160" value="${esc(input.summary)}"
            placeholder="One line. This is what search shows." autocomplete="off">
        </label>
        <fieldset class="policy-group">
          <legend>Procedure</legend>
          <div class="row">
            <label>Owner
              <input name="owner" required maxlength="200" value="${esc(input.owner ?? "")}" autocomplete="off" placeholder="Role accountable for these steps">
            </label>
            <label>Related policy
              <input name="related_policy" required maxlength="200" value="${esc(input.relatedPolicy ?? "")}" autocomplete="off" placeholder="Name of the policy this carries out">
            </label>
          </div>
          <label>When to use it
            <textarea name="when_to_use" required maxlength="8000" rows="4" placeholder="The moment someone should start these steps.">${esc(input.whenToUse ?? "")}</textarea>
          </label>
          <label>Steps
            <textarea name="steps" required maxlength="20000" rows="10" placeholder="One step per line.">${esc(input.steps ?? "")}</textarea>
          </label>
          <label>Who does each step
            <textarea name="who" required maxlength="8000" rows="4" placeholder="Which role does which step.">${esc(input.who ?? "")}</textarea>
          </label>
        </fieldset>
  `;
}
