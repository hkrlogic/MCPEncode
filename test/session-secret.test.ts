import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSessionSecret } from "../src/config.ts";

test("rejects a secret shorter than 32 characters", () => {
  assert.throws(() => assertSessionSecret("short"), /at least 32 characters/);
});

test("rejects the placeholder from .env.example", () => {
  assert.throws(() => assertSessionSecret("change-me-to-a-long-random-value"), /placeholder/);
});

test("rejects other change-me variants", () => {
  assert.throws(() => assertSessionSecret("CHANGEME-please-set-this-before-deploying"), /placeholder/);
});

test("rejects a repeated character", () => {
  assert.throws(() => assertSessionSecret("a".repeat(48)), /repetitive/);
});

test("accepts a random secret", () => {
  const secret = "q8Vt3mZ0rL6wN1yH4pK7sD2fG9jB5cX0eU3iO8aR";
  assert.equal(assertSessionSecret(secret), secret);
});

test("accepts the secret used by the test suite", () => {
  assert.doesNotThrow(() => assertSessionSecret("test-session-secret-32-bytes-minimum!!"));
});
