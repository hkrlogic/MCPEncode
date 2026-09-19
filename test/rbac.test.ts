import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRole, ROLE_PERMISSIONS, can, accessFromIdentity } from "../src/auth/rbac.ts";

test("edit wins over readonly when both claims appear", () => {
  assert.equal(
    resolveRole({ scopes: ["mpos:readonly", "mpos:edit"], roles: [] }),
    "edit",
  );
});

test("readonly resolves from Keycloak role names", () => {
  assert.equal(resolveRole({ scopes: [], roles: ["mpos-readonly"] }), "readonly");
});

test("unknown tokens have no role", () => {
  assert.equal(resolveRole({ scopes: ["openid"], roles: ["offline_access"] }), undefined);
});

test("edit is a permission superset of readonly", () => {
  const reader = accessFromIdentity({ sub: "r", clientId: "c", role: "readonly" });
  const editor = accessFromIdentity({ sub: "e", clientId: "c", role: "edit" });
  for (const permission of ROLE_PERMISSIONS.readonly) {
    assert.equal(can(reader, permission), true);
    assert.equal(can(editor, permission), true);
  }
  assert.equal(can(reader, "records.write"), false);
  assert.equal(can(reader, "records.delete"), false);
  assert.equal(can(editor, "records.write"), true);
  assert.equal(can(editor, "records.delete"), true);
});
