import assert from "node:assert/strict";
import { test } from "node:test";
import { staticUrl } from "../src/http/static-assets.ts";

test("static URLs include a stable content hash", () => {
  const first = staticUrl("styles.css");
  const second = staticUrl("styles.css");
  assert.match(first, /^\/static\/styles\.css\?v=[a-f0-9]{10}$/);
  assert.equal(first, second);
  assert.match(staticUrl("editor.js"), /^\/static\/editor\.js\?v=[a-f0-9]{10}$/);
});
