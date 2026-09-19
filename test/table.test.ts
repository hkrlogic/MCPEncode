import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownFromTable, parseMarkdownTable, sheetDataToTable, splitSummaryAndTable, tableToSheetData } from "../src/markdown/table.ts";

test("round-trips a grid to GitHub-flavored Markdown", () => {
  const md = markdownFromTable({
    headers: ["Item", "Qty"],
    rows: [
      ["Coffee", "2"],
      ["Filter", "1"],
    ],
  });
  assert.equal(
    md,
    ["| Item | Qty |", "| --- | --- |", "| Coffee | 2 |", "| Filter | 1 |"].join("\n"),
  );
  const parsed = parseMarkdownTable(md);
  assert.deepEqual(parsed?.headers, ["Item", "Qty"]);
  assert.deepEqual(parsed?.rows, [
    ["Coffee", "2"],
    ["Filter", "1"],
  ]);
});

test("does not treat prose as a table", () => {
  assert.equal(parseMarkdownTable("# Heading\n\nSome notes"), undefined);
});

test("splits a summary from a following table", () => {
  const md = [
    "Test Mon, Staging Tue, Prod Thu. No Friday.",
    "",
    "| Group | Monday | Tuesday |",
    "| --- | --- | --- |",
    "| Test | X |  |",
  ].join("\n");
  const split = splitSummaryAndTable(md);
  assert.equal(split.summary, "Test Mon, Staging Tue, Prod Thu. No Friday.");
  assert.deepEqual(split.table?.headers, ["Group", "Monday", "Tuesday"]);
  assert.equal(split.description, "");
});

test("keeps a table when checklist text follows it", () => {
  const md = [
    "Prod is Thursday.",
    "",
    "| Group | Monday |",
    "| --- | --- |",
    "| Test | X |",
    "",
    "- Friday: no patches",
  ].join("\n");
  const split = splitSummaryAndTable(md);
  assert.equal(split.summary, "Prod is Thursday.");
  assert.deepEqual(split.table?.headers, ["Group", "Monday"]);
  assert.match(split.description, /Friday: no patches/);
});

test("sheet data uses the first row as headers", () => {
  const data = tableToSheetData({
    headers: ["Item", "Qty"],
    rows: [["Coffee", "2"]],
  });
  assert.deepEqual(data[0]?.slice(0, 2), ["Item", "Qty"]);
  assert.deepEqual(sheetDataToTable(data.slice(0, 2)), {
    headers: ["Item", "Qty"],
    rows: [["Coffee", "2"]],
  });
});

test("padded empty columns are dropped when writing Markdown", () => {
  const md = markdownFromTable(
    sheetDataToTable(
      tableToSheetData({
        headers: ["Item", "Qty"],
        rows: [["Coffee", "2"]],
      }),
    ),
  );
  assert.equal(md, ["| Item | Qty |", "| --- | --- |", "| Coffee | 2 |"].join("\n"));
});
