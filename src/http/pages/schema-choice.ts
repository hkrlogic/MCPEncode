/**
 * Add-library schema picker and write-mode picker.
 * Field lists come from the same starters copied onto a library at create,
 * so the choice on screen matches the fields items will use.
 */
import { MAX_LIBRARY_FIELDS } from "../../items/field-proposal.ts";
import type { CustomFieldRow } from "../../items/custom-schema.ts";
import { schemaForStarter } from "../../items/library-schema.ts";
import type { LibraryWriteMode } from "../../items/schema.ts";
import type { LibraryTemplate } from "../../items/templates.ts";
import { esc } from "./layout.ts";

const SCHEMA_STARTERS = ["general", "policy", "procedure"] as const satisfies readonly LibraryTemplate[];

/** Custom is built on this form. Agent design of a schema is a later feature. */
const SCHEMA_CHOICES = [...SCHEMA_STARTERS, "custom"] as const;
type SchemaChoice = (typeof SCHEMA_CHOICES)[number];

const SCHEMA_TITLE: Record<SchemaChoice, string> = {
  general: "General",
  policy: "Policy",
  procedure: "Procedure",
  custom: "Custom",
};

/** One line under each option so the shape is visible before it is selected. */
const SCHEMA_BLURB: Record<SchemaChoice, string> = {
  general: "Name, labels, a one-line summary, and a markdown description.",
  policy: "Owner, version, dates, purpose, scope, and the policy text.",
  procedure: "Owner, related policy, when to use it, steps, and who does each step.",
  custom:
    "Name, labels, and a summary are on every item. Add the other fields here. After you add the library, those fields stay. You can add optional fields later. You cannot rename or remove these.",
};

const CUSTOM_FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "longtext", label: "Long text" },
] as const;

const WRITE_MODE_CHOICES = ["reviewed", "direct"] as const satisfies readonly LibraryWriteMode[];

const WRITE_MODE_TITLE: Record<LibraryWriteMode, string> = {
  reviewed: "Review Lock",
  direct: "Review Unlock",
};

const WRITE_MODE_BLURB: Record<LibraryWriteMode, string> = {
  reviewed: "Items stay Pending until you Publish.",
  direct: "Saves are live immediately for readers and agents.",
};

function fieldRows(starter: (typeof SCHEMA_STARTERS)[number]): { label: string; required: boolean }[] {
  const schema = schemaForStarter(starter);
  return [
    { label: "Name", required: true },
    { label: "Labels", required: false },
    { label: "Summary", required: true },
    ...schema.fields.map((field) => ({ label: field.label, required: field.required })),
  ];
}

function customFieldRow(row: CustomFieldRow): string {
  const types = CUSTOM_FIELD_TYPES.map((type) => {
    const selected = row.type === type.value ? " selected" : "";
    return `<option value="${type.value}"${selected}>${type.label}</option>`;
  }).join("");
  const required = row.required ? " selected" : "";
  const optional = row.required ? "" : " selected";
  return `
    <div class="custom-field-row" data-custom-field-row>
      <label class="custom-field-label">Label
        <input name="field_label" maxlength="40" value="${esc(row.label)}" autocomplete="off">
      </label>
      <label>Type
        <select name="field_type">${types}</select>
      </label>
      <label>Required
        <select name="field_required">
          <option value="optional"${optional}>No</option>
          <option value="required"${required}>Yes</option>
        </select>
      </label>
      <button class="btn secondary custom-field-remove" type="button" data-custom-field-remove>Remove</button>
    </div>`;
}

function customFieldsMarkup(rows: CustomFieldRow[]): string {
  const shown = rows.length > 0 ? rows : [{ label: "", type: "text", required: false }];
  const locked = [
    { label: "Name", required: true },
    { label: "Labels", required: false },
    { label: "Summary", required: true },
  ]
    .map(
      (field) =>
        `<li><span class="schema-field-name">${field.label}</span><span class="schema-field-req">${field.required ? "Required" : "Optional"}</span></li>`,
    )
    .join("");
  return `
    <div class="custom-fields" data-custom-fields data-custom-field-cap="${MAX_LIBRARY_FIELDS}">
      <p class="schema-blurb schema-blurb-guide">${esc(SCHEMA_BLURB.custom)}</p>
      <ul class="schema-fields">${locked}</ul>
      <p class="schema-prompt-label">Other fields <span class="hint">Up to ${MAX_LIBRARY_FIELDS}.</span></p>
      <div data-custom-field-list>${shown.map(customFieldRow).join("")}</div>
      <button class="btn secondary custom-field-add" type="button" data-custom-field-add>Add field</button>
      <template id="custom-field-template">${customFieldRow({ label: "", type: "text", required: false })}</template>
    </div>`;
}

/** Radios posted as `template`. Segmented control; detail panel shows the selected shape. */
export function schemaChoicesMarkup(input?: {
  selected?: string;
  customFields?: CustomFieldRow[];
}): string {
  const selected = SCHEMA_CHOICES.includes(input?.selected as SchemaChoice)
    ? (input?.selected as SchemaChoice)
    : undefined;
  const segments = SCHEMA_CHOICES.map((choice) => {
    const id = `schema-${choice}`;
    const checked = (selected ? choice === selected : choice === "general") ? " checked" : "";
    return `
      <label class="schema-segment" for="${id}">
        <input class="schema-radio schema-segment-radio" type="radio" name="template" id="${id}" value="${choice}" aria-describedby="${id}-detail"${checked}>
        <span class="schema-segment-label">${SCHEMA_TITLE[choice]}</span>
      </label>`;
  }).join("");

  const details = SCHEMA_CHOICES.map((choice) => {
    const id = `schema-${choice}`;
    if (choice === "custom") {
      return `
      <div class="schema-detail schema-detail-custom" id="${id}-detail">
        ${customFieldsMarkup(input?.customFields ?? [])}
      </div>`;
    }
    const fields = fieldRows(choice)
      .map(
        (field) =>
          `<li><span class="schema-field-name">${esc(field.label)}</span><span class="schema-field-req">${field.required ? "Required" : "Optional"}</span></li>`,
      )
      .join("");
    return `
      <div class="schema-detail schema-detail-${choice}" id="${id}-detail">
        <p class="schema-blurb">${esc(SCHEMA_BLURB[choice])}</p>
        <ul class="schema-fields">${fields}</ul>
      </div>`;
  }).join("");

  return `
    <fieldset class="schema-choices schema-choices-segmented">
      <legend>Data schema</legend>
      <div class="schema-segments">${segments}</div>
      <div class="schema-detail-panel">${details}</div>
    </fieldset>`;
}

/** Radios posted as `write_mode`. Required on Add library — no silent default in the UI. */
export function writeModeChoicesMarkup(selected?: LibraryWriteMode): string {
  const options = WRITE_MODE_CHOICES.map((mode) => {
    const id = `write-mode-${mode}`;
    const checked = selected === mode ? " checked" : "";
    return `
      <div class="schema-option">
        <input class="schema-radio" type="radio" name="write_mode" id="${id}" value="${mode}" aria-describedby="${id}-blurb" required${checked}>
        <label for="${id}">${WRITE_MODE_TITLE[mode]}</label>
        <p class="schema-blurb" id="${id}-blurb">${esc(WRITE_MODE_BLURB[mode])}</p>
      </div>`;
  }).join("");

  return `
    <fieldset class="schema-choices write-mode-choices">
      <legend>Write settings</legend>
      ${options}
    </fieldset>`;
}

export function writeModeLabel(mode: LibraryWriteMode): string {
  return WRITE_MODE_TITLE[mode];
}

export function writeModeBlurb(mode: LibraryWriteMode): string {
  return WRITE_MODE_BLURB[mode];
}
