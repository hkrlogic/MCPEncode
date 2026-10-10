/**
 * In-depth tests for propose_field, copy template, and rename.
 * Covers edge cases, multi-actor DB paths, and HTTP publisher routes.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import {
  addDraftItem,
  approveFieldProposal,
  approveTableProposal,
  copyLibraryTemplate,
  countLibraryItems,
  createLibrary,
  getLibrary,
  getLibraryAccess,
  grantLibraryAccess,
  listItems,
  proposeField,
  proposeTable,
  rejectFieldProposal,
  renameLibrary,
  updateItem,
} from "../src/db/queries.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import {
  MAX_LIBRARY_FIELDS,
  normalizeFieldProposal,
  parseStoredFieldProposal,
  schemaWithApprovedField,
} from "../src/items/field-proposal.ts";
import { itemForLibrarySchema, schemaForStarter } from "../src/items/library-schema.ts";
import { valuesForSchemaEdit } from "../src/items/table-proposal.ts";
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
    webClientId: "mpos-web",
    sessionSecret: SESSION_SECRET,
    database: {
      host: "127.0.0.1",
      port: 5432,
      user: "mpos",
      password: "stub-not-a-real-password",
      database: "mpos",
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

async function publisherCookie(sub: string, csrf: string, role: "sa" | "readonly" = "sa") {
  const token = await signSession(
    { sub, clientId: "mpos-web", role, csrf },
    SESSION_SECRET,
  );
  return `mpos_session=${token}`;
}

async function withPublisherApp(
  run: (input: {
    base: string;
    db: import("../src/db/types.ts").Database;
    cookie: string;
    csrf: string;
    sub: string;
  }) => Promise<void>,
) {
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
    const sub = "publisher-ada";
    const csrf = "csrf-token-ada";
    const cookie = await publisherCookie(sub, csrf, "sa");
    try {
      await run({ base, db, cookie, csrf, sub });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

// --- normalize / parse edge cases -------------------------------------------------

test("deep: field normalize rejects control chars, dates ok, cap, and key clash", () => {
  const schema = schemaForStarter("general");
  // Newlines collapse to spaces; raw control chars and < > are rejected.
  assert.equal(normalizeFieldProposal({ label: "Pri\nmary", type: "text" }, schema).ok, true);
  assert.equal(normalizeFieldProposal({ label: "Bad\u0001Label", type: "text" }, schema).ok, false);
  assert.equal(normalizeFieldProposal({ label: "A < B", type: "text" }, schema).ok, false);
  assert.equal(normalizeFieldProposal({ label: "When", type: "date" }, schema).ok, true);
  assert.equal(normalizeFieldProposal({ label: "Notes", type: "longtext" }, schema).ok, true);

  const full = {
    ...schemaForStarter("policy"),
    fields: Array.from({ length: MAX_LIBRARY_FIELDS }, (_, i) => ({
      key: `f${i}`,
      label: `F${i}`,
      type: "text" as const,
      required: false,
      kind: "control" as const,
    })),
  };
  assert.equal(normalizeFieldProposal({ label: "More", type: "text" }, full).ok, false);

  const withOwner = schemaForStarter("policy");
  assert.equal(normalizeFieldProposal({ label: "Owner", type: "text" }, withOwner).ok, false);
});

test("deep: approve helper forces optional and preserves starter", () => {
  const schema = schemaForStarter("procedure");
  const next = schemaWithApprovedField(schema, {
    key: "sla",
    label: "SLA",
    type: "text",
    required: false,
    proposedBy: "a",
    proposedAt: 1,
  });
  assert.equal(next.starter, "procedure");
  assert.equal(next.fields.at(-1)?.required, false);
  assert.equal(next.fields.at(-1)?.key, "sla");
  assert.equal(parseStoredFieldProposal({ key: "sla", label: "SLA", type: "text", required: true }).proposal?.required, false);
});

// --- DB integrity -----------------------------------------------------------------

test("deep: procedure copy keeps fields; add-on write works; source untouched", async () => {
  await withTestDatabase(async (db) => {
    const source = await createLibrary(db, "Visitor steps", "sam", "procedure", undefined, "reviewed");
    assert.equal(
      (await proposeField(db, source.id, { label: "SLA hours", type: "text" }, "sam")).ok,
      true,
    );
    assert.equal((await approveFieldProposal(db, source.id, "sam")).ok, true);

    const copy = await copyLibraryTemplate(db, source.id, "Visitor steps v2", "sam");
    assert.equal(copy.ok, true);
    if (!copy.ok) return;
    assert.equal(copy.library.template, "procedure");
    assert.ok(copy.library.schema.fields.some((field) => field.key === "sla_hours"));
    assert.equal(await countLibraryItems(db, copy.library.id), 0);

    const item = await addDraftItem(
      db,
      copy.library.id,
      {
        name: "Lobby check-in",
        summary: "Guest badge steps",
        owner: "Facilities",
        related_policy: "Visitor policy",
        when_to_use: "When a guest arrives",
        steps: "1. Sign in\n2. Issue badge",
        who: "Reception",
        sla_hours: "4",
      },
      "sam",
    );
    assert.equal(item.ok, true);
    if (!item.ok) return;
    assert.match(item.item.body, /SLA hours:\s*4/);

    // Source still has no items.
    assert.equal(await countLibraryItems(db, source.id), 0);
  });
});

test("deep: table library can add a field after Approve; writes accept it", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Roster", "sam", "general");
    assert.equal(
      (
        await proposeTable(
          db,
          library.id,
          {
            name: "On-call",
            columns: [
              { label: "Phone", type: "text", required: true },
              { label: "Shift", type: "text", required: true },
            ],
          },
          "sam",
        )
      ).ok,
      true,
    );
    assert.equal((await approveTableProposal(db, library.id, "sam")).ok, true);
    const table = await getLibrary(db, library.id);
    assert.equal(table?.schema.starter, "table");

    assert.equal((await proposeField(db, library.id, { label: "Site", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    const live = await getLibrary(db, library.id);
    const saved = itemForLibrarySchema(live!.schema, {
      name: "Alex",
      summary: "Nights",
      phone: "555",
      shift: "Night",
      site: "HQ",
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.match(saved.item.body, /Site:\s*HQ/);
  });
});

test("deep: reject then re-propose same label; duplicate key after approve fails", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Docs", "sam", "general");
    assert.equal((await proposeField(db, library.id, { label: "Priority", type: "text" }, "sam")).ok, true);
    assert.equal(await rejectFieldProposal(db, library.id, "sam"), true);
    assert.equal((await proposeField(db, library.id, { label: "Priority", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    assert.equal((await proposeField(db, library.id, { label: "Priority", type: "text" }, "sam")).ok, false);
    assert.equal((await proposeField(db, library.id, { label: "priority", type: "date" }, "sam")).ok, false);
  });
});

test("deep: Review Lock item stays draft with new field; update keeps Pending", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "KB", "sam", "general", undefined, "reviewed");
    assert.equal((await proposeField(db, library.id, { label: "System", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    const created = await addDraftItem(
      db,
      library.id,
      { name: "VPN", summary: "Home access", body: "Steps", system: "Cisco" },
      "sam",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.item.status, "draft");

    const live = await getLibrary(db, library.id);
    const reshaped = itemForLibrarySchema(live!.schema, {
      name: "VPN",
      summary: "Home access",
      body: "Updated steps",
      system: "GlobalProtect",
    });
    assert.equal(reshaped.ok, true);
    if (!reshaped.ok) return;
    const updated = await updateItem(db, created.item.id, reshaped.item, "sam");
    assert.ok(updated);
    assert.equal(updated.status, "draft");
    assert.match(updated.body, /GlobalProtect/);
    assert.match(updated.body, /Updated steps/);
    assert.equal((await listItems(db, { library_id: library.id }, { publishedOnly: true })).length, 0);
  });
});

test("deep: rename does not rotate Connect; copy does not share Access subjects", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Alpha", "alice", "general");
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "riley",
      role: "reader",
      grantedBy: "alice",
    });
    const token = library.connectToken;
    const renamed = await renameLibrary(db, library.id, "Alpha renamed", "alice");
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal(renamed.library.connectToken, token);

    const copy = await copyLibraryTemplate(db, library.id, "Beta", "alice");
    assert.equal(copy.ok, true);
    if (!copy.ok) return;
    assert.equal(await getLibraryAccess(db, copy.library.id, "riley"), undefined);
    assert.equal((await getLibraryAccess(db, copy.library.id, "alice"))?.role, "publisher");
    assert.equal((await getLibraryAccess(db, library.id, "riley"))?.role, "reader");
  });
});

test("deep: legacy Documents body seed survives copy+field growth path", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Runbooks", "sam", "general");
    const item = await addDraftItem(
      db,
      library.id,
      { name: "Backup", body: "## Nightly\n\nRun the job." },
      "sam",
    );
    assert.equal(item.ok, true);
    if (!item.ok) return;

    const copy = await copyLibraryTemplate(db, library.id, "Runbooks copy", "sam");
    assert.equal(copy.ok, true);
    if (!copy.ok) return;
    // Source item still seeds after source gains a field.
    assert.equal((await proposeField(db, library.id, { label: "Owner", type: "text" }, "sam")).ok, true);
    assert.equal((await approveFieldProposal(db, library.id, "sam")).ok, true);
    const live = await getLibrary(db, library.id);
    const seed = valuesForSchemaEdit(item.item, live!.schema);
    assert.equal(seed.body, "## Nightly\n\nRun the job.");
    // Copy stayed empty and without the new field until it grows itself.
    assert.equal(
      (await getLibrary(db, copy.library.id))?.schema.fields.some((field) => field.key === "owner"),
      false,
    );
  });
});

test("deep: concurrent second propose loses; waiting proposal is unchanged", async () => {
  await withTestDatabase(async (db) => {
    const library = await createLibrary(db, "Race", "sam", "general");
    const [a, b] = await Promise.all([
      proposeField(db, library.id, { label: "Alpha", type: "text" }, "sam"),
      proposeField(db, library.id, { label: "Bravo", type: "text" }, "sam"),
    ]);
    const wins = [a, b].filter((row) => row.ok);
    const losses = [a, b].filter((row) => !row.ok);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    const waiting = await getLibrary(db, library.id);
    assert.ok(waiting?.fieldProposal);
    assert.ok(["Alpha", "Bravo"].includes(waiting!.fieldProposal!.label));
  });
});

// --- HTTP publisher routes --------------------------------------------------------

test("deep HTTP: rename, copy, approve field, CSRF and reader denied", async () => {
  await withPublisherApp(async ({ base, db, cookie, csrf, sub }) => {
    const library = await createLibrary(db, "HTTP Lib", sub, "general", undefined, "reviewed");

    // Bad CSRF on rename.
    const badCsrf = await fetch(`${base}/libraries/${library.id}/rename`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf: "wrong", name: "Nope" }),
      redirect: "manual",
    });
    assert.equal(badCsrf.status, 403);

    const renamed = await fetch(`${base}/libraries/${library.id}/rename`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf, name: "HTTP Lib Renamed" }),
      redirect: "manual",
    });
    assert.equal(renamed.status, 302);
    assert.equal(renamed.headers.get("location"), `/libraries/${library.id}?renamed=1`);
    assert.equal((await getLibrary(db, library.id))?.name, "HTTP Lib Renamed");

    assert.equal((await proposeField(db, library.id, { label: "Tier", type: "text" }, sub)).ok, true);
    const approved = await fetch(`${base}/libraries/${library.id}/field/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    assert.equal(approved.headers.get("location"), `/libraries/${library.id}?field=approved`);
    assert.ok((await getLibrary(db, library.id))?.schema.fields.some((field) => field.key === "tier"));

    const copied = await fetch(`${base}/libraries/${library.id}/copy`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf, name: "HTTP Lib copy" }),
      redirect: "manual",
    });
    assert.equal(copied.status, 302);
    const copyLocation = copied.headers.get("location") ?? "";
    assert.match(copyLocation, /\/libraries\/[0-9a-f-]+\?copied=1$/);
    const copyId = copyLocation.split("/")[2]?.split("?")[0] ?? "";
    const copyRow = await getLibrary(db, copyId);
    assert.ok(copyRow);
    assert.equal(copyRow.name, "HTTP Lib copy");
    assert.ok(copyRow.schema.fields.some((field) => field.key === "tier"));
    assert.equal(await countLibraryItems(db, copyId), 0);

    // Reader session cannot copy.
    await grantLibraryAccess(db, {
      libraryId: library.id,
      subject: "reader-riley",
      role: "reader",
      grantedBy: sub,
    });
    const readerCookie = await publisherCookie("reader-riley", "csrf-reader", "readonly");
    const readerCopy = await fetch(`${base}/libraries/${library.id}/copy`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: readerCookie,
      },
      body: new URLSearchParams({ csrf: "csrf-reader", name: "Stolen" }),
      redirect: "manual",
    });
    assert.equal(readerCopy.status, 403);

    const page = await fetch(`${base}/libraries/${copyId}?copied=1`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Library template copied/);
    assert.match(html, /HTTP Lib copy/);
    assert.match(html, /propose_field/);
  });
});

test("deep HTTP: field reject clears wait; invalid rename stays put", async () => {
  await withPublisherApp(async ({ base, db, cookie, csrf, sub }) => {
    const library = await createLibrary(db, "Reject me", sub, "policy");
    assert.equal((await proposeField(db, library.id, { label: "Audience", type: "longtext" }, sub)).ok, true);

    const rejected = await fetch(`${base}/libraries/${library.id}/field/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    assert.equal(rejected.status, 302);
    assert.equal(rejected.headers.get("location"), `/libraries/${library.id}?field=rejected`);
    assert.equal((await getLibrary(db, library.id))?.fieldProposal, null);

    const invalid = await fetch(`${base}/libraries/${library.id}/rename`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf, name: "   " }),
      redirect: "manual",
    });
    assert.equal(invalid.status, 302);
    assert.equal(invalid.headers.get("location"), `/libraries/${library.id}?renamed=invalid`);
    assert.equal((await getLibrary(db, library.id))?.name, "Reject me");
  });
});
