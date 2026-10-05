import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createItem,
  createLibrary,
  getPublishedSchema,
  listFieldValues,
  publishItem,
  publishSchema,
  replaceFieldValues,
  saveDraftSchema,
} from "../src/db/queries.ts";
import {
  validateFieldValues,
  type LibrarySchemaDoc,
} from "../src/items/library-schema.ts";
import { presentItem } from "../src/items/present.ts";
import { withTestDatabase } from "./db.ts";

const sampleSchema: LibrarySchemaDoc = {
  fields: [
    { key: "hostname", label: "Hostname", type: "string", required: true, max: 200 },
    { key: "os", label: "OS", type: "enum", required: true, values: ["Windows 11", "Windows 10"] },
    { key: "last_patched", label: "Last patched", type: "date", required: false },
  ],
};

describe("library schema + typed rows", () => {
  it("validates field values against the schema", () => {
    const ok = validateFieldValues(sampleSchema, {
      hostname: "host-42",
      os: "Windows 11",
      last_patched: "2026-03-01",
    });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.rows.length, 3);

    const bad = validateFieldValues(sampleSchema, { hostname: "x", os: "Linux" });
    assert.equal(bad.ok, false);
  });

  it("publishes a schema, stores typed rows, and presents them", async () => {
    await withTestDatabase(async (db) => {
      const library = await createLibrary(db, "Patch inventory", "editor", "general");
      await saveDraftSchema(db, library.id, sampleSchema, "editor");
      const published = await publishSchema(db, library.id, "editor");
      assert.equal(published.status, "published");
      assert.equal(published.fields.fields.length, 3);

      const live = await getPublishedSchema(db, library.id);
      assert.ok(live);
      assert.equal(live.version, published.version);

      const validated = validateFieldValues(live.fields, {
        hostname: "laptop-1",
        os: "Windows 11",
        last_patched: "2026-04-01",
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;

      const item = await createItem(
        db,
        {
          name: "laptop-1",
          summary: "Win11 laptop",
          body: "",
          labels: ["inventory"],
          details: null,
        },
        "editor",
        library.id,
      );
      await replaceFieldValues(db, item.id, validated.rows);
      await publishItem(db, item.id, "editor");

      const rows = await listFieldValues(db, item.id);
      assert.equal(rows.length, 3);
      const wire = await presentItem(db, item);
      assert.match(wire, /Hostname: laptop-1/);
      assert.match(wire, /OS: Windows 11/);
      assert.match(wire, /Last patched: 2026-04-01/);
    });
  });
});
