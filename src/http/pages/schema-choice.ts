/**
 * Add-library schema picker and write-mode picker.
 * Field lists come from the same starters copied onto a library at create,
 * so the choice on screen matches the fields items will use.
 */
import { schemaForStarter } from "../../items/library-schema.ts";
import type { LibraryWriteMode } from "../../items/schema.ts";
import type { LibraryTemplate } from "../../items/templates.ts";
import { esc } from "./layout.ts";

const SCHEMA_CHOICES = ["general", "policy", "procedure"] as const satisfies readonly LibraryTemplate[];

const SCHEMA_TITLE: Record<(typeof SCHEMA_CHOICES)[number], string> = {
  general: "General",
  policy: "Policy",
  procedure: "Procedure",
};

/** One line under each option so the shape is visible before it is selected. */
const SCHEMA_BLURB: Record<(typeof SCHEMA_CHOICES)[number], string> = {
  general: "Name, labels, a one-line summary, and a markdown description.",
  policy: "Owner, version, dates, purpose, scope, and the policy text.",
  procedure: "Owner, related policy, when to use it, steps, and who does each step.",
};

const WRITE_MODE_CHOICES = ["reviewed", "direct"] as const satisfies readonly LibraryWriteMode[];

const WRITE_MODE_TITLE: Record<LibraryWriteMode, string> = {
  reviewed: "Reviewed",
  direct: "Direct",
};

const WRITE_MODE_BLURB: Record<LibraryWriteMode, string> = {
  reviewed: "Items stay Pending until you Publish.",
  direct: "Saves are live immediately for readers and agents.",
};

function fieldRows(starter: (typeof SCHEMA_CHOICES)[number]): { label: string; required: boolean }[] {
  const schema = schemaForStarter(starter);
  return [
    { label: "Name", required: true },
    { label: "Labels", required: false },
    { label: "Summary", required: true },
    ...schema.fields.map((field) => ({ label: field.label, required: field.required })),
  ];
}

/** Radios posted as `template`. Selecting one reveals that starter’s fields. */
export function schemaChoicesMarkup(): string {
  const options = SCHEMA_CHOICES.map((starter) => {
    const id = `schema-${starter}`;
    const checked = starter === "general" ? " checked" : "";
    const fields = fieldRows(starter)
      .map(
        (field) =>
          `<li><span class="schema-field-name">${esc(field.label)}</span><span class="schema-field-req">${field.required ? "Required" : "Optional"}</span></li>`,
      )
      .join("");
    return `
      <div class="schema-option">
        <input class="schema-radio" type="radio" name="template" id="${id}" value="${starter}" aria-describedby="${id}-blurb"${checked}>
        <label for="${id}">${SCHEMA_TITLE[starter]}</label>
        <p class="schema-blurb" id="${id}-blurb">${esc(SCHEMA_BLURB[starter])}</p>
        <ul class="schema-fields">${fields}</ul>
      </div>`;
  }).join("");

  return `
    <fieldset class="schema-choices">
      <legend>Schema</legend>
      ${options}
    </fieldset>`;
}

/** Radios posted as `write_mode`. Required on Add library — no silent default in the UI. */
export function writeModeChoicesMarkup(): string {
  const options = WRITE_MODE_CHOICES.map((mode) => {
    const id = `write-mode-${mode}`;
    return `
      <div class="schema-option">
        <input class="schema-radio" type="radio" name="write_mode" id="${id}" value="${mode}" aria-describedby="${id}-blurb" required>
        <label for="${id}">${WRITE_MODE_TITLE[mode]}</label>
        <p class="schema-blurb" id="${id}-blurb">${esc(WRITE_MODE_BLURB[mode])}</p>
      </div>`;
  }).join("");

  return `
    <fieldset class="schema-choices write-mode-choices">
      <legend>How writes go live</legend>
      ${options}
    </fieldset>`;
}

export function writeModeLabel(mode: LibraryWriteMode): string {
  return WRITE_MODE_TITLE[mode];
}

export function writeModeBlurb(mode: LibraryWriteMode): string {
  return WRITE_MODE_BLURB[mode];
}
