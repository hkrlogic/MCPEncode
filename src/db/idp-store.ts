/** Postgres store for the built-in identity provider: clients, refresh chains, signing key. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { CallbackHostRecord, CallbackHostStatus, IdpStore, OAuthClient, RefreshRecord, SigningKeyRecord } from "../auth/idp-store.ts";
import type { KnownGoodStore } from "../auth/signin-limit.ts";
import { allRows, getRow, runSql } from "./query-helpers.ts";
import type { Database } from "./types.ts";

type ClientRow = { client_id: string; client_name: string; redirect_uris: unknown; created_at: number };
type RefreshRow = {
  token_hash: string;
  chain_id: string;
  subject: string;
  client_id: string;
  resource: string;
  chain_started_at: number;
  expires_at: number;
  used_at: number | null;
};
type HostRow = {
  host: string;
  status: string;
  first_seen: number;
  last_seen: number;
  sample_client_name: string;
  decided_by: string | null;
  decided_at: number | null;
};
const HOST_COLUMNS = "host, status, first_seen, last_seen, sample_client_name, decided_by, decided_at";

function toHost(row: HostRow): CallbackHostRecord {
  return {
    host: row.host,
    status: row.status as CallbackHostStatus,
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    sampleClientName: row.sample_client_name,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
  };
}

type KeyRow = { kid: string; public_jwk: unknown; private_jwk_enc: string; created_at: number };

function toClient(row: ClientRow): OAuthClient {
  const uris = typeof row.redirect_uris === "string" ? JSON.parse(row.redirect_uris) : row.redirect_uris;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: Array.isArray(uris) ? uris.filter((uri): uri is string => typeof uri === "string") : [],
    createdAt: Number(row.created_at),
  };
}

function toRefresh(row: RefreshRow): RefreshRecord {
  return {
    tokenHash: row.token_hash,
    chainId: row.chain_id,
    sub: row.subject,
    clientId: row.client_id,
    resource: row.resource,
    chainStartedAt: Number(row.chain_started_at),
    expiresAt: Number(row.expires_at),
    usedAt: row.used_at === null ? null : Number(row.used_at),
  };
}

/** AES-256-GCM key for the signing key at rest, derived from SESSION_SECRET. */
function wrapKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "mcpencode-idp-signing-key", "v1", 32));
}

export function sealPrivateJwk(jwk: Record<string, unknown>, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(jwk), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function openPrivateJwk(sealed: string, secret: string): Record<string, unknown> | undefined {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrapKey(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function postgresIdpStore(db: Database, sessionSecret: string): IdpStore {
  return {
    async saveClient(client) {
      await runSql(
        db,
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, registered_from)
         VALUES (?, ?, ?::jsonb, ?, ?)`,
        client.clientId,
        client.clientName,
        JSON.stringify(client.redirectUris),
        client.createdAt,
        client.registeredFrom ?? null,
      );
    },
    async findClient(clientId) {
      const row = await getRow<ClientRow>(
        db,
        "SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?",
        clientId,
      );
      return row ? toClient(row) : undefined;
    },
    async pruneClients(before) {
      await runSql(
        db,
        `DELETE FROM oauth_clients AS c
         WHERE c.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens AS r WHERE r.client_id = c.client_id)`,
        before,
      );
    },
    async countPendingClients(since) {
      const row = await getRow<{ n: string | number }>(
        db,
        `SELECT COUNT(*) AS n FROM oauth_clients AS c
         WHERE c.created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens AS r WHERE r.client_id = c.client_id)`,
        since,
      );
      return Number(row?.n ?? 0);
    },
    async countPendingClientsFrom(since, registeredFrom) {
      const row = await getRow<{ n: string | number }>(
        db,
        `SELECT COUNT(*) AS n FROM oauth_clients AS c
         WHERE c.registered_from = ? AND c.created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens AS r WHERE r.client_id = c.client_id)`,
        registeredFrom,
        since,
      );
      return Number(row?.n ?? 0);
    },
    async insertRefresh(record) {
      await runSql(
        db,
        `INSERT INTO oauth_refresh_tokens
           (token_hash, chain_id, subject, client_id, resource, chain_started_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.tokenHash,
        record.chainId,
        record.sub,
        record.clientId,
        record.resource,
        record.chainStartedAt,
        record.expiresAt,
        record.usedAt,
      );
    },
    async claimRefresh(tokenHash, now) {
      return db.transaction(async (tx) => {
        // One UPDATE decides the race: two requests with the same token cannot both win.
        const claimed = await getRow<RefreshRow>(
          tx,
          `UPDATE oauth_refresh_tokens SET used_at = ?
           WHERE token_hash = ? AND used_at IS NULL
           RETURNING token_hash, chain_id, subject, client_id, resource, chain_started_at, expires_at, used_at`,
          now,
          tokenHash,
        );
        if (claimed) return { status: "ok" as const, record: toRefresh(claimed) };
        const used = await getRow<RefreshRow>(
          tx,
          `SELECT token_hash, chain_id, subject, client_id, resource, chain_started_at, expires_at, used_at
           FROM oauth_refresh_tokens WHERE token_hash = ?`,
          tokenHash,
        );
        if (!used) return { status: "missing" as const };
        await runSql(tx, "DELETE FROM oauth_refresh_tokens WHERE chain_id = ?", used.chain_id);
        return { status: "reused" as const, record: toRefresh(used) };
      });
    },
    async revokeChain(chainId) {
      await runSql(db, "DELETE FROM oauth_refresh_tokens WHERE chain_id = ?", chainId);
    },
    async revokeSubject(sub) {
      await runSql(db, "DELETE FROM oauth_refresh_tokens WHERE subject = ?", sub);
    },
    async pruneRefresh(before) {
      await runSql(db, "DELETE FROM oauth_refresh_tokens WHERE chain_started_at < ?", before);
    },
    async findHost(host) {
      const row = await getRow<HostRow>(db, `SELECT ${HOST_COLUMNS} FROM callback_hosts WHERE host = ?`, host);
      return row ? toHost(row) : undefined;
    },
    async approvedHosts() {
      const rows = await allRows<{ host: string }>(db, "SELECT host FROM callback_hosts WHERE status = 'approved'");
      return rows.map((row) => row.host);
    },
    async listHosts() {
      const rows = await allRows<HostRow>(db, `SELECT ${HOST_COLUMNS} FROM callback_hosts ORDER BY last_seen DESC LIMIT 1000`);
      return rows.map(toHost);
    },
    async notePendingHost({ host, clientName, now, maxPending }) {
      return db.transaction(async (tx) => {
        // One writer at a time, so two registrations cannot both slip under the cap.
        await tx.get("SELECT pg_advisory_xact_lock(hashtext('mcpencode-callback-hosts'))");
        const updated = await getRow<{ host: string }>(
          tx,
          `UPDATE callback_hosts
           SET last_seen = ?, sample_client_name = CASE WHEN sample_client_name = '' THEN ? ELSE sample_client_name END
           WHERE host = ? RETURNING host`,
          now,
          clientName,
          host,
        );
        if (updated) return "seen" as const;
        const pending = await getRow<{ n: string | number }>(
          tx,
          "SELECT COUNT(*) AS n FROM callback_hosts WHERE status = 'pending'",
        );
        if (Number(pending?.n ?? 0) >= maxPending) return "full" as const;
        await runSql(
          tx,
          `INSERT INTO callback_hosts (host, status, first_seen, last_seen, sample_client_name)
           VALUES (?, 'pending', ?, ?, ?)`,
          host,
          now,
          now,
          clientName,
        );
        return "created" as const;
      });
    },
    async decideHost({ host, status, by, now }) {
      const row = await getRow<HostRow>(
        db,
        `INSERT INTO callback_hosts (host, status, first_seen, last_seen, sample_client_name, decided_by, decided_at)
         VALUES (?, ?, ?, ?, '', ?, ?)
         ON CONFLICT (host) DO UPDATE SET status = EXCLUDED.status, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at
         RETURNING ${HOST_COLUMNS}`,
        host,
        status,
        now,
        now,
        by,
        now,
      );
      if (!row) throw new Error("callback host was not saved");
      return toHost(row);
    },
    async revokeHostTokens(host) {
      const rows = await allRows<{ token_hash: string }>(
        db,
        `DELETE FROM oauth_refresh_tokens AS r
         USING oauth_clients AS c
         WHERE r.client_id = c.client_id
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(c.redirect_uris) AS u(uri)
             WHERE lower(substring(u.uri from ?)) = ?
           )
         RETURNING r.token_hash`,
        // A parameter: the query helper turns every ? in the SQL into a placeholder.
        "^https?://([^/:?#]+)",
        host,
      );
      return rows.length;
    },
    async signingKey(create) {
      return db.transaction(async (tx) => {
        // Two processes starting at once must agree on one key.
        await tx.get("SELECT pg_advisory_xact_lock(hashtext('mcpencode-idp-signing-key'))");
        const rows = await allRows<KeyRow>(
          tx,
          `SELECT kid, public_jwk, private_jwk_enc, created_at FROM oauth_signing_keys
           WHERE retired_at IS NULL ORDER BY created_at DESC`,
        );
        for (const row of rows) {
          const privateJwk = openPrivateJwk(row.private_jwk_enc, sessionSecret);
          if (!privateJwk) continue;
          const publicJwk =
            typeof row.public_jwk === "string" ? JSON.parse(row.public_jwk) : (row.public_jwk as Record<string, unknown>);
          return { kid: row.kid, publicJwk, privateJwk, createdAt: Number(row.created_at) };
        }
        if (rows.length > 0) {
          console.log(
            "The stored sign-in signing key cannot be read with this SESSION_SECRET. Making a new one; everyone signs in again.",
          );
          await runSql(tx, "UPDATE oauth_signing_keys SET retired_at = ? WHERE retired_at IS NULL", Date.now());
        }
        const key: SigningKeyRecord = await create();
        await runSql(
          tx,
          `INSERT INTO oauth_signing_keys (kid, public_jwk, private_jwk_enc, created_at)
           VALUES (?, ?::jsonb, ?, ?)`,
          key.kid,
          JSON.stringify(key.publicJwk),
          sealPrivateJwk(key.privateJwk, sessionSecret),
          key.createdAt,
        );
        return key;
      });
    },
  };
}

/** Postgres copy of the sign-in throttle's known-good addresses (migration 016). */
export function postgresKnownGoodStore(db: Database): KnownGoodStore {
  return {
    async load(since, limit) {
      const rows = await allRows<{ pair_hash: string; last_success: number }>(
        db,
        `SELECT pair_hash, last_success FROM signin_known_good
         WHERE last_success >= ? ORDER BY last_success DESC LIMIT ?`,
        since,
        limit,
      );
      return rows.map((row) => ({ key: row.pair_hash, at: Number(row.last_success) })).reverse();
    },
    async remember(key, at, expireBefore, limit) {
      await runSql(
        db,
        `INSERT INTO signin_known_good (pair_hash, last_success) VALUES (?, ?)
         ON CONFLICT (pair_hash) DO UPDATE SET last_success = EXCLUDED.last_success`,
        key,
        at,
      );
      await runSql(db, "DELETE FROM signin_known_good WHERE last_success < ?", expireBefore);
      await runSql(
        db,
        `DELETE FROM signin_known_good WHERE pair_hash IN (
           SELECT pair_hash FROM signin_known_good ORDER BY last_success DESC OFFSET ?)`,
        limit,
      );
    },
  };
}
