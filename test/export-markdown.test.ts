import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemRow, LibraryRow } from "../src/db/models.ts";
import { itemToMarkdown, markdownExportFilename } from "../src/items/export-markdown.ts";

function library(partial: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Docs",
    template: "general",
    writeMode: "reviewed",
    schema: { starter: "general", fields: [] },
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: null,
    fieldProposalUnreadable: false,
    connectToken: "test-connect-token-aaaaaaaaaaaaaaaaaa",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

function item(partial: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "item-1",
    library_id: "11111111-1111-4111-8111-111111111111",
    name: "VPN access",
    entity_key: null,
    labels: ["network", "remote"],
    summary: "How staff connect from home.",
    body: "## Steps\n\n1. Open the client.\n2. Sign in.",
    status: "published",
    details: null,
    published_snapshot: null,
    previous_published_snapshot: null,
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

test("filename is a safe .md basename", () => {
  assert.equal(markdownExportFilename("VPN access"), "VPN access.md");
  assert.equal(markdownExportFilename('a/b:c*?.md'), "a-b-c-.md");
  assert.equal(markdownExportFilename("   "), "item.md");
});

test("general item export is clean Markdown", () => {
  const md = itemToMarkdown(item(), library());
  assert.match(md, /^# VPN access\n/);
  assert.match(md, /How staff connect from home\./);
  assert.match(md, /Labels: network, remote/);
  assert.match(md, /## Steps/);
  assert.doesNotMatch(md, /Published|Pending|entity_key|item-1/);
});

test("export tolerates null-ish summary body and labels", () => {
  const md = itemToMarkdown(
    item({
      summary: null as unknown as string,
      body: null as unknown as string,
      labels: null as unknown as string[],
    }),
    library(),
  );
  assert.match(md, /^# VPN access\n/);
  assert.doesNotMatch(md, /Labels:/);
});

test("policy item export uses control and body sections", () => {
  const md = itemToMarkdown(
    item({
      name: "Acceptable use",
      summary: "Staff rules for company systems.",
      labels: [],
      body: "",
      policy: {
        owner: "IT",
        approved_by: "CISO",
        version: "1.0",
        effective_date: "2026-01-01",
        review_date: "2027-01-01",
        purpose: "Keep systems safe.",
        scope: "All staff.",
        policy: "Do not share passwords.",
        responsibilities: "",
        exceptions: "",
        references: "",
      },
    }),
    library({ template: "policy", schema: { starter: "policy", fields: [] } }),
  );
  assert.match(md, /^# Acceptable use\n/);
  assert.match(md, /\*\*Owner:\*\* IT/);
  assert.match(md, /## Purpose/);
  assert.match(md, /Keep systems safe\./);
  assert.match(md, /## Policy/);
  assert.doesNotMatch(md, /Template: Policy/);
});
