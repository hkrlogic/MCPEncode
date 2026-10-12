import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import { createLibrary, getLibrary } from "../src/db/queries.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { customSchemaFromRows } from "../src/items/custom-schema.ts";
import { itemForLibrarySchema, parseLibrarySchema } from "../src/items/library-schema.ts";
import { withTestDatabase } from "./db.ts";

const SESSION_SECRET = "test-session-secret-32-bytes-minimum!!";

function testConfig(port: number): AppConfig {
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    bindHost: "127.0.0.1",
    publicBaseUrl: origin,
    allowedHosts: [],
    authMode: "embedded",
    authIssuer: `${origin}/id`,
    authJwksUrl: `${origin}/id/jwks`,
    authAudience: origin,
    webClientId: "mcpencode-web",
    sessionSecret: SESSION_SECRET,
    database: {
      host: "127.0.0.1",
      port: 5432,
      user: "mcpencode",
      password: "stub-not-a-real-password",
      database: "mcpencode",
      ssl: false,
    },
  };
}

function stubAuthServer(issuer: string): AuthServerEndpoints {
  return {
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
    },
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

test("custom schema locks the fields the human listed", () => {
  const built = customSchemaFromRows([
    { label: "Priority", type: "text", required: true },
    { label: "", type: "text", required: false },
    { label: "Due", type: "date", required: false },
    { label: "Notes", type: "longtext", required: false },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.schema.custom, true);
  assert.equal(built.schema.starter, "general");
  assert.deepEqual(
    built.schema.fields.map((field) => [field.key, field.type, field.required, field.kind]),
    [
      ["priority", "text", true, "control"],
      ["due", "date", false, "control"],
      ["notes", "longtext", false, "body"],
    ],
  );

  const saved = itemForLibrarySchema(built.schema, {
    name: "Lobby badge",
    summary: "Replace lost badges",
    labels: ["ops"],
    priority: "High",
    due: "2026-10-10",
    notes: "Ask the desk",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.match(saved.item.body, /Template: Custom/);
  assert.match(saved.item.body, /Priority: High/);

  const foreign = itemForLibrarySchema(built.schema, {
    name: "Lobby badge",
    summary: "Replace lost badges",
    priority: "High",
    purpose: "not on this schema",
  });
  assert.equal(foreign.ok, false);
});

test("custom schema rejects reserved, duplicate, and over-cap fields", () => {
  const reserved = customSchemaFromRows([{ label: "Name", type: "text", required: true }]);
  assert.equal(reserved.ok, false);

  const duplicate = customSchemaFromRows([
    { label: "Priority", type: "text", required: false },
    { label: "priority", type: "text", required: false },
  ]);
  assert.equal(duplicate.ok, false);

  const markup = customSchemaFromRows([{ label: "<script>", type: "text", required: false }]);
  assert.equal(markup.ok, false);

  const tooMany = customSchemaFromRows(
    Array.from({ length: 13 }, (_, index) => ({
      label: `Field ${index + 1}`,
      type: "text",
      required: false,
    })),
  );
  assert.equal(tooMany.ok, false);
});

test("an empty custom schema is name, labels, and summary only", () => {
  const built = customSchemaFromRows([{ label: "  ", type: "text", required: false }]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.schema.fields.length, 0);
  const saved = itemForLibrarySchema(built.schema, {
    name: "Index",
    summary: "Just the one-liner",
    labels: [],
  });
  assert.equal(saved.ok, true);
  const markdown = itemForLibrarySchema(built.schema, {
    name: "Index",
    body: "free description",
  });
  assert.equal(markdown.ok, false);
});

test("create stores a custom schema and reads it back", async () => {
  await withTestDatabase(async (db) => {
    const built = customSchemaFromRows([
      { label: "Site", type: "text", required: true },
    ]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const library = await createLibrary(
      db,
      "Sites",
      "alice",
      "general",
      undefined,
      "reviewed",
      built.schema,
    );
    assert.equal(library.schema.custom, true);
    assert.equal(library.schema.fields[0]?.key, "site");
    const reloaded = await getLibrary(db, library.id);
    assert.deepEqual(reloaded?.schema, parseLibrarySchema(library.schema));
  });
});

test("Add library Custom posts a locked schema and General ignores those fields", async () => {
  await withTestDatabase(async (db) => {
    const probe = testConfig(34567);
    const app = createApp({
      config: probe,
      db,
      authServer: stubAuthServer(probe.authIssuer),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const csrf = "csrf-token-ada";
    const token = await signSession(
      { sub: "publisher-ada", clientId: "mcpencode-web", role: "sa", csrf },
      SESSION_SECRET,
    );
    const cookie = `mcpencode_session=${token}`;
    try {
      const page = await fetch(`${base}/libraries/new`, { headers: { cookie } });
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /name="field_label"/);
      assert.match(html, /Add field/);
      assert.match(html, /name="write_mode"/);
      assert.match(html, /custom-schema\.js/);
      assert.doesNotMatch(html, /designed in your agent chat/);

      const created = await fetch(`${base}/libraries`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["csrf", csrf],
          ["name", "Sites"],
          ["template", "custom"],
          ["write_mode", "reviewed"],
          ["field_label", "Site"],
          ["field_type", "text"],
          ["field_required", "required"],
          ["field_label", ""],
          ["field_type", "date"],
          ["field_required", "optional"],
        ]),
      });
      assert.equal(created.status, 302);
      const libraryUrl = created.headers.get("location") ?? "";
      assert.match(libraryUrl, /^\/libraries\/[0-9a-f-]{36}$/);
      const libraryId = libraryUrl.split("/").pop() ?? "";
      const stored = await getLibrary(db, libraryId);
      assert.equal(stored?.schema.custom, true);
      assert.deepEqual(
        stored?.schema.fields.map((field) => [field.key, field.required]),
        [["site", true]],
      );

      const addItem = await fetch(`${base}/libraries/${libraryId}/items/new`, { headers: { cookie } });
      const itemHtml = await addItem.text();
      assert.equal(addItem.status, 200);
      assert.match(itemHtml, /name="site"/);
      assert.match(itemHtml, /Site/);
      assert.match(itemHtml, /Fill the fields for this library/);

      const rejected = await fetch(`${base}/libraries`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["csrf", csrf],
          ["name", "Bad"],
          ["template", "custom"],
          ["write_mode", "reviewed"],
          ["field_label", "Summary"],
          ["field_type", "text"],
          ["field_required", "required"],
        ]),
      });
      assert.equal(rejected.status, 400);
      const rejectedHtml = await rejected.text();
      assert.match(rejectedHtml, /already part of every item/);
      assert.match(rejectedHtml, /id="schema-custom"[^>]*checked/);

      const general = await fetch(`${base}/libraries`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["csrf", csrf],
          ["name", "Notes"],
          ["template", "general"],
          ["write_mode", "direct"],
          ["field_label", "Site"],
          ["field_type", "text"],
          ["field_required", "required"],
        ]),
      });
      assert.equal(general.status, 302);
      const generalId = (general.headers.get("location") ?? "").split("/").pop() ?? "";
      const notes = await getLibrary(db, generalId);
      assert.equal(notes?.schema.custom, undefined);
      assert.equal(notes?.writeMode, "direct");
      assert.equal(notes?.schema.fields.some((field) => field.key === "site"), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
