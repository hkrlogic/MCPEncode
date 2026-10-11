import assert from "node:assert/strict";
import { test } from "node:test";
import { originAllowed } from "../src/http/origin.ts";

const allowed = ["127.0.0.1", "localhost"];

test("a sign-in redirect with Origin null is allowed", () => {
  assert.deepEqual(
    originAllowed({
      origin: "null",
      method: "GET",
      secFetchMode: "navigate",
      allowedHostnames: allowed,
    }),
    { ok: true },
  );
});

test("a fetch that sends Origin null is rejected", () => {
  const result = originAllowed({
    origin: "null",
    method: "POST",
    secFetchMode: "cors",
    allowedHostnames: allowed,
  });
  assert.equal(result.ok, false);
});

test("another site's origin is rejected", () => {
  const result = originAllowed({
    origin: "https://evil.example",
    method: "POST",
    secFetchMode: "cors",
    allowedHostnames: allowed,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /evil\.example/);
});

test("the publisher's own origin is allowed", () => {
  assert.equal(
    originAllowed({
      origin: "http://127.0.0.1:3000",
      method: "POST",
      secFetchMode: "cors",
      allowedHostnames: allowed,
    }).ok,
    true,
  );
});
