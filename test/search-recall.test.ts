/**
 * Search recall on natural questions and typos (#30). Reproduces the
 * validation run: 18 help-desk questions and the Biology tutor questions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createItem,
  createLibrary,
  createShelf,
  getLibrary,
  lookupItems,
  publishItem,
  searchShelf,
  setLibraryShelf,
} from "../src/db/queries.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import type { LookupResult } from "../src/db/lookup.ts";
import { editDistance } from "../src/db/lookup.ts";
import type { Database } from "../src/db/types.ts";
import { type FixtureItem, HELP_DESK_RUNBOOKS, INTRO_BIOLOGY } from "./fixtures/search-library.ts";
import { withTestDatabase } from "./db.ts";

async function seed(db: Database, name: string, items: FixtureItem[]): Promise<string> {
  const library = await createLibrary(db, name, "teacher");
  for (const item of items) {
    const row = await createItem(
      db,
      {
        name: item.name,
        summary: item.summary,
        body: item.body,
        labels: item.labels.split(",").map((label) => label.trim()).filter(Boolean),
      },
      "teacher",
      library.id,
    );
    await publishItem(db, row.id, "teacher");
  }
  return library.id;
}

type Outcome = "answer" | "choices" | "miss";

/** answer: the expected item came back as the one match. choices: it is first in a list or suggestions. */
function outcome(result: LookupResult, expected: string): Outcome {
  if (result.kind === "item") return result.item.name === expected ? "answer" : "miss";
  if (result.kind === "list" || result.kind === "suggest") return result.items[0]?.name === expected ? "choices" : "miss";
  return "miss";
}

const reader = { publishedOnly: true } as const;

type Tool = { handler: (args: unknown, extra: unknown) => Promise<{ content?: { text: string }[] }> };
const readerAuth: AuthInfo = {
  token: "test",
  clientId: "test-client",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { sub: "reader", role: "readonly" },
};

const RUNBOOK_QUESTIONS: [string, string][] = [
  ["VPN Troubleshooting", "vpn not connecting"],
  ["VPN Troubleshooting", "my VPN keeps dropping when I work from home"],
  ["VPN Troubleshooting", "vnp trouble"],
  ["VPN Troubleshooting", "cant reach the office network from home"],
  ["Account Lockout", "account lockout"],
  ["Account Lockout", "user is locked out of their account"],
  ["Account Lockout", "I forgot my password and got locked out"],
  ["Account Lockout", "acount lokout"],
  ["Printer Queue Reset", "printer stuck"],
  ["Printer Queue Reset", "print jobs are stuck in the queue"],
  ["Printer Queue Reset", "priner queue"],
  ["New Laptop Setup", "set up a new laptop for a new hire"],
  ["New Laptop Setup", "onboarding computer"],
  ["New Laptop Setup", "laptp setup"],
  ["Incident Response Runbook", "we think we got phished, what do we do"],
  ["Incident Response Runbook", "security incident"],
  ["Incident Response Runbook", "ransomware"],
  ["Incident Response Runbook", "incdent respnse"],
];

function names(result: LookupResult): string[] {
  if (result.kind === "item") return [result.item.name];
  if (result.kind === "list" || result.kind === "suggest") return result.items.map((item) => item.name);
  return [];
}

test("help desk: 16 of the 18 validation questions now find the right runbook (was 6)", async () => {
  await withTestDatabase(async (db) => {
    const libraryId = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const outcomes = new Map<string, Outcome>();
    for (const [expected, q] of RUNBOOK_QUESTIONS) {
      outcomes.set(q, outcome(await lookupItems(db, { library_id: libraryId, q }, reader), expected));
    }
    const found = [...outcomes.values()].filter((value) => value !== "miss").length;
    assert.ok(found >= 16, `found ${found}/18: ${JSON.stringify([...outcomes])}`);
    // Every typo from the validation run.
    for (const q of ["vnp trouble", "acount lokout", "priner queue", "laptp setup", "incdent respnse"]) {
      assert.notEqual(outcomes.get(q), "miss", q);
    }
    // Typos with a clear target come back as the one answer.
    assert.equal(outcomes.get("acount lokout"), "answer");
    assert.equal(outcomes.get("incdent respnse"), "answer");
    // Natural sentences.
    assert.equal(outcomes.get("print jobs are stuck in the queue"), "answer");
    assert.notEqual(outcomes.get("my VPN keeps dropping when I work from home"), "miss");
    assert.notEqual(outcomes.get("I forgot my password and got locked out"), "miss");
    assert.notEqual(outcomes.get("set up a new laptop for a new hire"), "miss");
    // Known gaps: no shared words (needs synonyms or semantic search).
    assert.equal(outcomes.get("we think we got phished, what do we do"), "miss");
  });
});

test("help desk: a label question returns every item with that label, not one confident answer", async () => {
  await withTestDatabase(async (db) => {
    const libraryId = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const result = await lookupItems(db, { library_id: libraryId, q: "runbook" }, reader);
    assert.equal(result.kind, "list");
    assert.deepEqual(names(result).sort(), HELP_DESK_RUNBOOKS.map((item) => item.name).sort());
  });
});

test("out-of-scope questions are still refused (no did-you-mean noise)", async () => {
  await withTestDatabase(async (db) => {
    const helpDesk = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const biology = await seed(db, "Course: Intro to Biology", INTRO_BIOLOGY);
    for (const q of ["how do I request a parking pass", "what is the wifi password for guests"]) {
      assert.equal((await lookupItems(db, { library_id: helpDesk, q }, reader)).kind, "none", q);
    }
    for (const q of ["what is photosynthesis", "explain DNA replication", "what does the mitochondria do", "mitocondria"]) {
      assert.equal((await lookupItems(db, { library_id: biology, q }, reader)).kind, "none", q);
    }
  });
});

test("tutor: natural student questions find the course material (were refused)", async () => {
  await withTestDatabase(async (db) => {
    const biology = await seed(db, "Course: Intro to Biology", INTRO_BIOLOGY);
    const ask = async (q: string) => lookupItems(db, { library_id: biology, q }, reader);
    const homework = await ask("when is homework due and what happens if I am late");
    assert.equal(homework.kind, "item");
    assert.deepEqual(names(homework), ["Homework & Late Work Policy"]);
    assert.deepEqual(names(await ask("how is the lab report graded")), ["Lab Report Rubric"]);
    assert.deepEqual(names(await ask("grading")), ["Lab Report Rubric"]);
    const wikipedia = await ask("can I cite wikipedia in my lab report");
    assert.equal(wikipedia.kind, "suggest", "partial match is offered, not asserted");
    assert.ok(names(wikipedia).includes("Approved Reading List"));
    // Only one of two words matches: offered as a suggestion, not a confident answer.
    assert.equal((await ask("cell membrane")).kind, "suggest");
  });
});

test("typo correction: did_you_mean carries the corrected spelling", async () => {
  await withTestDatabase(async (db) => {
    const helpDesk = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const result = await lookupItems(db, { library_id: helpDesk, q: "acount lokout" }, reader);
    assert.equal(result.kind, "item");
    if (result.kind === "item") assert.equal(result.corrected, "account lockout");
    assert.equal(editDistance("vnp", "vpn"), 1);
    assert.equal(editDistance("lokout", "lockout"), 1);
    assert.ok(editDistance("parking", "printing") > 2);
  });
});

test("MCP list_items: suggestions and spelling corrections are labelled for the agent", async () => {
  await withTestDatabase(async (db) => {
    const libraryId = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const library = await getLibrary(db, libraryId);
    assert.ok(library);
    const server = buildMcpServer(db, readerAuth, {
      libraryId,
      libraryName: library.name,
      libraryRole: "reader",
      idpRole: "readonly",
      schema: library.schema,
      writeMode: library.writeMode,
      readerKey: true,
    });
    const tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools.list_items;
    assert.ok(tool);
    const text = async (q: string) =>
      ((await tool.handler({ q }, {})).content ?? []).map((part) => part.text).join("\n");

    const suggest = JSON.parse(await text("onboarding computer")) as { notice: string; items: { name: string }[] };
    assert.match(suggest.notice, /Did you mean one of these\? Open one with open_item and cite it only if it answers the question/);
    assert.equal(suggest.items[0]?.name, "New Laptop Setup");

    assert.match(await text("acount lokout"), /found after correcting the spelling to "account lockout"/);
    assert.match(await text("how do I request a parking pass"), /No matching item in this library/);
  });
});

test("search_shelf: a phrase that is not verbatim still finds items with every word", async () => {
  await withTestDatabase(async (db) => {
    const libraryId = await seed(db, "Help Desk Runbooks", HELP_DESK_RUNBOOKS);
    const shelf = await createShelf(db, "Support Desk", "teacher");
    assert.equal(shelf.ok, true);
    if (!shelf.ok) return;
    await setLibraryShelf(db, libraryId, shelf.shelf.id, "teacher");
    const scope = { subject: "teacher", sa: true };
    assert.deepEqual(
      (await searchShelf(db, shelf.shelf.id, "unlock account", scope)).map((hit) => hit.name),
      ["Account Lockout"],
    );
    assert.equal((await searchShelf(db, shelf.shelf.id, "parking pass", scope)).length, 0);
  });
});
