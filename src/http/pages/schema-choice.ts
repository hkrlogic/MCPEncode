/**
 * Add-library schema picker and write-mode picker.
 * Field lists come from the same starters copied onto a library at create,
 * so the choice on screen matches the fields items will use.
 */
import { schemaForStarter } from "../../items/library-schema.ts";
import type { LibraryWriteMode } from "../../items/schema.ts";
import type { LibraryTemplate } from "../../items/templates.ts";
import { esc } from "./layout.ts";

const SCHEMA_STARTERS = ["general", "policy", "procedure"] as const satisfies readonly LibraryTemplate[];

/** UI-only option: Custom is designed in agent chat, not on this form. */
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
    "In your agentic LLM chat (with this publisher’s MCP connected), ask it to design a library. It will ask what the library is for, then help define the schema and create it.",
};

/** Example chat prompts that start the custom-library design conversation. */
const CUSTOM_SCHEMA_PROMPTS = [
  "I would like to make a new library",
  "Help me design a library for …",
  "Create a custom library and walk me through the fields",
] as const;

const WRITE_MODE_CHOICES = ["reviewed", "direct"] as const satisfies readonly LibraryWriteMode[];

const WRITE_MODE_TITLE: Record<LibraryWriteMode, string> = {
  reviewed: "Publisher Review",
  direct: "Live Sync",
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

/** Radios posted as `template`. Segmented control; detail panel shows the selected shape. */
export function schemaChoicesMarkup(): string {
  const segments = SCHEMA_CHOICES.map((choice) => {
    const id = `schema-${choice}`;
    const checked = choice === "general" ? " checked" : "";
    return `
      <label class="schema-segment" for="${id}">
        <input class="schema-radio schema-segment-radio" type="radio" name="template" id="${id}" value="${choice}" aria-describedby="${id}-detail"${checked}>
        <span class="schema-segment-label">${SCHEMA_TITLE[choice]}</span>
      </label>`;
  }).join("");

  const details = SCHEMA_CHOICES.map((choice) => {
    const id = `schema-${choice}`;
    if (choice === "custom") {
      const prompts = CUSTOM_SCHEMA_PROMPTS.map(
        (prompt) => `<li><q>${esc(prompt)}</q></li>`,
      ).join("");
      return `
      <div class="schema-detail schema-detail-custom" id="${id}-detail">
        <p class="schema-blurb schema-blurb-guide">${esc(SCHEMA_BLURB.custom)}</p>
        <p class="schema-prompt-label">Try saying:</p>
        <ul class="schema-prompt-samples">${prompts}</ul>
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
