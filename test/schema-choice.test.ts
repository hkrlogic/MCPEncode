import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_PERMISSIONS } from "../src/auth/rbac.ts";
import { addLibraryPage, librariesPage } from "../src/http/pages.ts";

const editor = {
  sub: "alice",
  clientId: "test",
  role: "sa" as const,
  permissions: ROLE_PERMISSIONS.sa,
};

test("add library shows each schema and its fields", () => {
  const html = addLibraryPage({
    access: editor,
    csrf: "token",
    libraries: [],
  });
  assert.match(html, /<legend>Data schema<\/legend>/);
  assert.match(html, /schema-choices-segmented/);
  assert.match(html, /schema-segments/);
  assert.match(html, /name="template" id="schema-general" value="general"/);
  assert.match(html, /name="template" id="schema-policy" value="policy"/);
  assert.match(html, /name="template" id="schema-procedure" value="procedure"/);
  assert.match(html, /name="template" id="schema-custom" value="custom"/);
  assert.match(html, /class="schema-detail schema-detail-general"/);
  assert.match(html, /class="schema-detail schema-detail-custom"/);
  assert.match(html, /agentic LLM chat/);
  assert.match(html, /I would like to make a new library/);
  assert.match(html, /schema-prompt-samples/);
  assert.match(html, /Effective date/);
  assert.match(html, /Who does each step/);
  assert.match(html, /Description/);
  assert.doesNotMatch(html, /<select name="template">/);
  assert.match(html, /<legend>Write settings<\/legend>/);
  assert.match(html, /name="write_mode" id="write-mode-reviewed" value="reviewed"/);
  assert.match(html, /name="write_mode" id="write-mode-direct" value="direct"/);
  assert.match(html, /<label for="write-mode-direct">Review Unlock<\/label>/);
  assert.match(html, /Items stay Pending until you Publish/);
  assert.match(html, /Saves are live immediately for readers and agents/);
});

test("readers do not see the schema choice", () => {
  const html = librariesPage({
    access: {
      sub: "bob",
      clientId: "test",
      role: "readonly",
      permissions: ROLE_PERMISSIONS.readonly,
    },
    csrf: "token",
    libraries: [],
  });
  assert.doesNotMatch(html, /schema-choices/);
  assert.doesNotMatch(html, /write-mode-choices/);
  assert.doesNotMatch(html, /href="\/libraries\/new"/);
});

test("publishers open Add library in the main pane", () => {
  const html = librariesPage({
    access: editor,
    csrf: "token",
    libraries: [],
  });
  assert.match(html, /href="\/libraries\/new"/);
  assert.doesNotMatch(html, /schema-choices/);
});
