import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessForLibrary,
  accessFromIdentity,
  can,
  resolveRole,
  ROLE_PERMISSIONS,
} from "../src/auth/rbac.ts";

test("SA wins over readonly when both claims appear", () => {
  assert.equal(
    resolveRole({ scopes: ["mpos:readonly", "mpos:edit"], roles: [] }),
    "sa",
  );
  assert.equal(resolveRole({ scopes: ["mpos:sa"], roles: [] }), "sa");
});

test("built-in mcpencode:* scopes resolve, and tokens with the older mpos:* scopes still do", () => {
  assert.equal(resolveRole({ scopes: ["openid", "mcpencode:readonly"], roles: [] }), "readonly");
  assert.equal(resolveRole({ scopes: ["mcpencode:edit", "mcpencode:sa"], roles: [] }), "sa");
  assert.equal(resolveRole({ scopes: ["mpos:readonly"], roles: [] }), "readonly");
});

test("readonly resolves from IdP role names", () => {
  assert.equal(resolveRole({ scopes: [], roles: ["mpos-readonly"] }), "readonly");
});

test("unknown tokens have no role", () => {
  assert.equal(resolveRole({ scopes: ["openid"], roles: ["offline_access"] }), undefined);
});

test("SA is a permission superset of readonly and library publisher", () => {
  const reader = accessFromIdentity({ sub: "r", clientId: "c", role: "readonly" });
  const sa = accessFromIdentity({ sub: "e", clientId: "c", role: "sa" });
  for (const permission of ROLE_PERMISSIONS.readonly) {
    assert.equal(can(reader, permission), true);
    assert.equal(can(sa, permission), true);
  }
  assert.equal(can(reader, "records.write"), false);
  assert.equal(can(reader, "records.delete"), false);
  assert.equal(can(sa, "records.write"), true);
  assert.equal(can(sa, "records.delete"), true);
  assert.equal(can(sa, "libraries.create"), true);
  assert.equal(can(sa, "accounts.manage"), true);

  const publisher = accessForLibrary({
    sub: "p",
    clientId: "c",
    idpRole: "readonly",
    libraryRole: "publisher",
  });
  assert.ok(publisher);
  assert.equal(can(publisher, "records.write"), true);
  assert.equal(can(publisher, "libraries.delete"), true);
  assert.equal(can(publisher, "records.delete"), false);
  assert.equal(can(publisher, "libraries.create"), false);
});
