import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_PERMISSIONS } from "../src/auth/rbac.ts";
import { librariesPage } from "../src/http/pages.ts";

const editor = {
  sub: "alice",
  clientId: "test",
  role: "edit" as const,
  permissions: ROLE_PERMISSIONS.edit,
};

test("add library shows each schema and its fields", () => {
  const html = librariesPage({
    access: editor,
    csrf: "token",
    libraries: [],
  });
  assert.match(html, /<legend>Schema<\/legend>/);
  assert.match(html, /name="template" id="schema-general" value="general"/);
  assert.match(html, /name="template" id="schema-policy" value="policy"/);
  assert.match(html, /name="template" id="schema-procedure" value="procedure"/);
  assert.match(html, /Effective date/);
  assert.match(html, /Who does each step/);
  assert.match(html, /Description/);
  assert.doesNotMatch(html, /<select name="template">/);
  assert.match(html, /<legend>How writes go live<\/legend>/);
  assert.match(html, /name="write_mode" id="write-mode-reviewed" value="reviewed"/);
  assert.match(html, /name="write_mode" id="write-mode-direct" value="direct"/);
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
});
