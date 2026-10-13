/** Revert working item fields to published_snapshot (not archive Restore). */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { accessFromLibraryRole } from "../src/auth/rbac.ts";
import { signSession } from "../src/auth/session.ts";
import type { AppConfig } from "../src/config.ts";
import {
  archiveItem,
  canRevertToPublished,
  createLibrary,
  createItem,
  getItem,
  listAudit,
  publishItem,
  restoreItem,
  revertToPublished,
  updateItem,
} from "../src/db/queries.ts";
import type { LibraryRow } from "../src/db/models.ts";
import { createApp } from "../src/http/app.ts";
import type { AuthServerEndpoints } from "../src/http/discovery.ts";
import { itemPage } from "../src/http/pages/items.ts";
import { noticeMessage } from "../src/http/pages/layout.ts";
import { itemForLibrary } from "../src/items/templates.ts";
import { withTestDatabase } from "./db.ts";

const publisher = accessFromLibraryRole({
  sub: "alice",
  clientId: "test",
  libraryRole: "publisher",
});

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

function library(partial: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Windows patching",
    template: "general",
    writeMode: "reviewed",
    schema: { starter: "general", fields: [] },
    tableProposal: null,
    tableProposalUnreadable: false,
    fieldProposal: null,
    fieldProposalUnreadable: false,
    connectTokenLast4: "aaaa",
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

test("noticeMessage explains reverted Pending state", () => {
  assert.match(noticeMessage("reverted"), /Reverted to the last published version/);
  assert.match(noticeMessage("reverted"), /Pending/);
  assert.match(noticeMessage("reverted_previous"), /previous published version/);
  assert.match(noticeMessage("reverted_previous"), /Readers still see the current published copy/);
});

test("canRevertToPublished follows Diff rules", () => {
  const snapshot = {
    name: "VPN",
    labels: ["remote"],
    summary: "Use company VPN",
    body: "Use company VPN",
    details: null,
    published_at: 1,
  };
  const previous = {
    name: "VPN",
    labels: ["remote"],
    summary: "Older VPN",
    body: "Use company VPN",
    details: null,
    published_at: 1,
  };
  assert.equal(
    canRevertToPublished({
      status: "draft",
      published_snapshot: snapshot,
      previous_published_snapshot: null,
      name: "VPN",
      labels: ["remote"],
      summary: "Use company VPN",
      body: "Use company VPN",
      details: null,
    }),
    false,
  );
  assert.equal(
    canRevertToPublished({
      status: "draft",
      published_snapshot: snapshot,
      previous_published_snapshot: null,
      name: "VPN",
      labels: ["remote"],
      summary: "Changed summary",
      body: "Use company VPN",
      details: null,
    }),
    true,
  );
  // After Publish, working matches current snapshot — previous still unlocks Revert.
  assert.equal(
    canRevertToPublished({
      status: "published",
      published_snapshot: snapshot,
      previous_published_snapshot: previous,
      name: "VPN",
      labels: ["remote"],
      summary: "Use company VPN",
      body: "Use company VPN",
      details: null,
    }),
    true,
  );
  assert.equal(
    canRevertToPublished({
      status: "archived",
      published_snapshot: snapshot,
      previous_published_snapshot: previous,
      name: "VPN",
      labels: ["remote"],
      summary: "Changed",
      body: "Use company VPN",
      details: null,
    }),
    false,
  );
  assert.equal(
    canRevertToPublished({
      status: "draft",
      published_snapshot: null,
      previous_published_snapshot: null,
      name: "VPN",
      labels: [],
      summary: "x",
      body: "y",
      details: null,
    }),
    false,
  );
});

test("item page shows Revert to published only when Diff has changes", () => {
  const lib = library();
  const base = {
    id: "item-1",
    library_id: lib.id,
    name: "Patch Tuesday",
    entity_key: "patch-tuesday",
    labels: ["ops"],
    summary: "Monthly",
    body: "Apply",
    status: "draft" as const,
    details: null,
    published_snapshot: {
      name: "Patch Tuesday",
      labels: ["ops"],
      summary: "Monthly",
      body: "Apply old",
      details: null,
      published_at: 10,
    },
    previous_published_snapshot: null,
    created_by: "alice",
    updated_by: "alice",
    created_at: 0,
    updated_at: 0,
  };
  const withDiff = itemPage({
    access: publisher,
    csrf: "token",
    item: base,
    library: lib,
    html: "<p>Apply</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(withDiff, /Revert to published/);
  assert.match(withDiff, /action="\/items\/item-1\/revert-published"/);
  assert.doesNotMatch(withDiff, />Restore</);
  assert.doesNotMatch(withDiff, /Restore to Pending/);

  const matching = itemPage({
    access: publisher,
    csrf: "token",
    item: {
      ...base,
      body: "Apply old",
      published_snapshot: { ...base.published_snapshot, body: "Apply old" },
      previous_published_snapshot: null,
    },
    library: lib,
    html: "<p>Apply old</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.doesNotMatch(matching, /Revert to published/);
  assert.doesNotMatch(matching, /Revert to previous published/);

  const afterPublish = itemPage({
    access: publisher,
    csrf: "token",
    item: {
      ...base,
      status: "published",
      body: "Apply old",
      published_snapshot: { ...base.published_snapshot!, body: "Apply old", published_at: 20 },
      previous_published_snapshot: {
        name: "Patch Tuesday",
        labels: ["ops"],
        summary: "Monthly",
        body: "Apply first",
        details: null,
        published_at: 10,
      },
    },
    library: lib,
    html: "<p>Apply old</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(afterPublish, /Revert to previous published/);
  assert.match(afterPublish, /Previous published/);

  const unlock = itemPage({
    access: publisher,
    csrf: "token",
    item: base,
    library: library({ writeMode: "direct" }),
    html: "<p>Apply</p>",
    shell: { libraries: [], csrf: "token", canAddLibrary: true },
  });
  assert.match(unlock, /keeps the previous one for Revert/);
});

test("publish → edit → publish keeps previous; revert restores prior published copy", async () => {
  await withTestDatabase(async (db) => {
    const libraryRow = await createLibrary(db, "Prior seal", "alice");
    const created = await createItem(
      db,
      {
        name: "VPN",
        body: "Use company VPN",
        labels: ["remote"],
        summary: "Company VPN",
        entity_key: "vpn-prior",
      },
      "alice",
      libraryRow.id,
    );
    const first = await publishItem(db, created.id, "alice");
    assert.equal(first?.status, "published");
    assert.equal(first?.previous_published_snapshot, null);
    const firstBody = first!.published_snapshot!.body;

    await updateItem(
      db,
      created.id,
      {
        name: "VPN",
        body: "Use personal VPN",
        labels: ["remote"],
        summary: "Wrong VPN",
        entity_key: "vpn-prior",
      },
      "alice",
    );
    const second = await publishItem(db, created.id, "alice");
    assert.equal(second?.status, "published");
    assert.equal(second?.body, "Use personal VPN");
    assert.equal(second?.published_snapshot?.body, "Use personal VPN");
    assert.equal(second?.previous_published_snapshot?.body, firstBody);

    const result = await revertToPublished(db, created.id, "alice");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "previous");
    assert.equal(result.item.status, "draft");
    assert.equal(result.item.body, firstBody);
    assert.equal(result.item.summary, "Company VPN");
    // Live published snapshot stays until Publish — readers still see the bad copy.
    assert.equal(result.item.published_snapshot?.body, "Use personal VPN");
    assert.equal(result.item.previous_published_snapshot?.body, firstBody);
  });
});

test("publish → edit → revert restores snapshot fields; entity_key and snapshot stay", async () => {
  await withTestDatabase(async (db) => {
    const libraryRow = await createLibrary(db, "Access", "alice");
    const created = await createItem(
      db,
      {
        name: "VPN",
        body: "Use company VPN",
        labels: ["remote"],
        summary: "Company VPN",
        entity_key: "vpn-access",
      },
      "alice",
      libraryRow.id,
    );
    const published = await publishItem(db, created.id, "alice");
    assert.equal(published?.status, "published");
    const snapBody = published!.published_snapshot!.body;
    const snapAt = published!.published_snapshot!.published_at;

    const edited = await updateItem(
      db,
      created.id,
      {
        name: "VPN bad",
        body: "Use personal VPN",
        labels: ["bad"],
        summary: "Wrong summary",
        entity_key: "vpn-access",
      },
      "alice",
    );
    assert.equal(edited?.status, "draft");
    assert.equal(edited?.published_snapshot?.body, snapBody);

    const result = await revertToPublished(db, created.id, "alice");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.item.status, "draft");
    assert.equal(result.item.name, "VPN");
    assert.equal(result.item.body, snapBody);
    assert.equal(result.item.summary, "Company VPN");
    assert.deepEqual(result.item.labels, ["remote"]);
    assert.equal(result.item.entity_key, "vpn-access");
    assert.equal(result.item.published_snapshot?.body, snapBody);
    assert.equal(result.item.published_snapshot?.published_at, snapAt);

    const again = await revertToPublished(db, created.id, "alice");
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.reason, "no_changes");
  });
});

test("revert refuses no snapshot, archived, and keeps policy details", async () => {
  await withTestDatabase(async (db) => {
    const general = await createLibrary(db, "Never live", "alice");
    const draft = await createItem(
      db,
      { name: "Draft only", body: "not published", labels: [] },
      "alice",
      general.id,
    );
    const noSnap = await revertToPublished(db, draft.id, "alice");
    assert.equal(noSnap.ok, false);
    if (!noSnap.ok) assert.equal(noSnap.reason, "no_snapshot");

    const policyLib = await createLibrary(db, "Approved policies", "alice", "policy");
    const shaped = itemForLibrary("policy", {
      name: "Remote access",
      summary: "Guest network.",
      labels: ["remote"],
      owner: "Office Lead",
      approved_by: "Security",
      version: "1.0",
      effective_date: "2026-09-01",
      review_date: "2027-09-01",
      purpose: "Limit guest access.",
      scope: "Guests.",
      policy: "Guests use the gateway.",
      responsibilities: "Office Lead.",
      exceptions: "",
      references: "",
    });
    assert.equal(shaped.ok, true);
    if (!shaped.ok) return;
    const policyItem = await createItem(db, shaped.item, "alice", policyLib.id);
    await publishItem(db, policyItem.id, "alice");
    const liveDetails = (await getItem(db, policyItem.id, { publishedOnly: false }))?.details;
    assert.ok(liveDetails);

    const badShape = itemForLibrary("policy", {
      name: "Remote access",
      summary: "Broken edit.",
      labels: ["remote"],
      owner: "Wrong",
      approved_by: "Security",
      version: "9.9",
      effective_date: "2026-09-01",
      review_date: "2027-09-01",
      purpose: "Limit guest access.",
      scope: "Guests.",
      policy: "Allow everything.",
      responsibilities: "Office Lead.",
      exceptions: "",
      references: "",
    });
    assert.equal(badShape.ok, true);
    if (!badShape.ok) return;
    await updateItem(db, policyItem.id, badShape.item, "alice");

    const reverted = await revertToPublished(db, policyItem.id, "alice");
    assert.equal(reverted.ok, true);
    if (!reverted.ok) return;
    assert.equal(reverted.item.details, liveDetails);
    assert.equal(reverted.item.policy?.owner, "Office Lead");
    assert.equal(reverted.item.policy?.policy, "Guests use the gateway.");

    await publishItem(db, policyItem.id, "alice");
    const archived = await archiveItem(db, policyItem.id, "alice");
    assert.equal(archived?.status, "archived");
    const archivedRevert = await revertToPublished(db, policyItem.id, "alice");
    assert.equal(archivedRevert.ok, false);
    if (!archivedRevert.ok) assert.equal(archivedRevert.reason, "archived");
    await restoreItem(db, policyItem.id, "alice");
  });
});

test("HTTP revert-published: success, CSRF, and reader denied", async () => {
  await withTestDatabase(async (db) => {
    const probe = testConfig(34568);
    const app = createApp({
      config: probe,
      db,
      authServer: stubAuthServer(probe.authIssuer),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const csrf = "csrf-revert";
    const cookie = `mcpencode_session=${await signSession(
      { sub: "publisher-ada", clientId: "mcpencode-web", role: "sa", csrf },
      SESSION_SECRET,
    )}`;

    try {
      const libraryRow = await createLibrary(db, "HTTP revert", "publisher-ada");
      const item = await createItem(
        db,
        {
          name: "Ring",
          body: "Thursday",
          labels: ["ops"],
          summary: "Weekly",
          entity_key: "ring-1",
        },
        "publisher-ada",
        libraryRow.id,
      );
      await publishItem(db, item.id, "publisher-ada");
      await updateItem(
        db,
        item.id,
        {
          name: "Ring",
          body: "Friday",
          labels: ["ops"],
          summary: "Weekly",
          entity_key: "ring-1",
        },
        "publisher-ada",
      );

      const badCsrf = await fetch(`${base}/items/${item.id}/revert-published`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "wrong" }),
        redirect: "manual",
      });
      assert.equal(badCsrf.status, 403);

      const readerCookie = `mcpencode_session=${await signSession(
        { sub: "reader-riley", clientId: "mcpencode-web", role: "readonly", csrf: "csrf-reader" },
        SESSION_SECRET,
      )}`;
      const readerDenied = await fetch(`${base}/items/${item.id}/revert-published`, {
        method: "POST",
        headers: { Cookie: readerCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "csrf-reader" }),
        redirect: "manual",
      });
      assert.equal(readerDenied.status, 403);

      const ok = await fetch(`${base}/items/${item.id}/revert-published`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf }),
        redirect: "manual",
      });
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get("location"), `/items/${item.id}?notice=reverted`);

      const row = await getItem(db, item.id, { publishedOnly: false });
      assert.equal(row?.body, "Thursday");
      assert.equal(row?.status, "draft");
      assert.equal(row?.entity_key, "ring-1");

      const events = await listAudit(db, item.library_id, 20);
      assert.ok(
        events.some(
          (event) =>
            event.tool === "ui.revert_to_published" &&
            event.success &&
            event.detail.includes(item.id),
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
