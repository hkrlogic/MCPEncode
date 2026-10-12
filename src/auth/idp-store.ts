/**
 * What the built-in identity provider keeps between requests: registered
 * clients, refresh-token chains, and its signing key. Postgres keeps them in
 * production (src/db/idp-store.ts), so a restart does not sign people out and
 * a registration survives a deploy. Tests use the in-memory store.
 */
import { createHash, randomBytes } from "node:crypto";

export type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};

/** One refresh token. Tokens in one chain share chainId and chainStartedAt. */
export type RefreshRecord = {
  tokenHash: string;
  chainId: string;
  sub: string;
  clientId: string;
  resource: string;
  /** When the person signed in. The chain ends at chainStartedAt + the maximum lifetime. */
  chainStartedAt: number;
  expiresAt: number;
  /** Set when this token was exchanged for the next one. Presenting it again is reuse. */
  usedAt: number | null;
};

/**
 * - ok: the token was active and is now marked used. The caller issues the next one.
 * - reused: the token had already been rotated. The whole chain was revoked.
 * - missing: unknown, revoked, or removed.
 */
export type RefreshClaim =
  | { status: "ok"; record: RefreshRecord }
  | { status: "reused"; record: RefreshRecord }
  | { status: "missing" };

/** Signing key as stored. privateJwk is plain JSON; the Postgres store encrypts it at rest. */
export type SigningKeyRecord = {
  kid: string;
  publicJwk: Record<string, unknown>;
  privateJwk: Record<string, unknown>;
  createdAt: number;
};

export type IdpStore = {
  saveClient(client: OAuthClient): Promise<void>;
  findClient(clientId: string): Promise<OAuthClient | undefined>;
  /** Drop registrations that never got a refresh token and are older than `before`. */
  pruneClients(before: number): Promise<void>;
  /** Registrations made at or after `since` that have not yet got a refresh token (pending sign-in). */
  countPendingClients(since: number): Promise<number>;
  insertRefresh(record: RefreshRecord): Promise<void>;
  /** Atomically mark an active token used. Reuse of a used token revokes its chain. */
  claimRefresh(tokenHash: string, now: number): Promise<RefreshClaim>;
  revokeChain(chainId: string): Promise<void>;
  /** Sign-out and password changes: every chain this account holds. */
  revokeSubject(sub: string): Promise<void>;
  /** Remove rows whose chain started before `before` (past the maximum lifetime). */
  pruneRefresh(before: number): Promise<void>;
  /** The active signing key, creating it with `create` when there is none. Safe to call from two processes. */
  signingKey(create: () => Promise<SigningKeyRecord>): Promise<SigningKeyRecord>;
};

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Random, unguessable, and not a UUID so it cannot be mistaken for an account id. */
export function newClientId(): string {
  return `mcp_${randomBytes(18).toString("base64url")}`;
}

export function memoryIdpStore(): IdpStore {
  const clients = new Map<string, OAuthClient>();
  const tokens = new Map<string, RefreshRecord>();
  let key: SigningKeyRecord | undefined;
  return {
    async saveClient(client) {
      clients.set(client.clientId, { ...client, redirectUris: [...client.redirectUris] });
    },
    async findClient(clientId) {
      return clients.get(clientId);
    },
    async pruneClients(before) {
      const used = new Set([...tokens.values()].map((row) => row.clientId));
      for (const [id, client] of clients) {
        if (client.createdAt < before && !used.has(id)) clients.delete(id);
      }
    },
    async countPendingClients(since) {
      const used = new Set([...tokens.values()].map((row) => row.clientId));
      let count = 0;
      for (const [id, client] of clients) if (client.createdAt >= since && !used.has(id)) count += 1;
      return count;
    },
    async insertRefresh(record) {
      tokens.set(record.tokenHash, { ...record });
    },
    async claimRefresh(tokenHash, now) {
      const row = tokens.get(tokenHash);
      if (!row) return { status: "missing" };
      if (row.usedAt !== null) {
        for (const [hash, entry] of tokens) if (entry.chainId === row.chainId) tokens.delete(hash);
        return { status: "reused", record: { ...row } };
      }
      row.usedAt = now;
      return { status: "ok", record: { ...row } };
    },
    async revokeChain(chainId) {
      for (const [hash, entry] of tokens) if (entry.chainId === chainId) tokens.delete(hash);
    },
    async revokeSubject(sub) {
      for (const [hash, entry] of tokens) if (entry.sub === sub) tokens.delete(hash);
    },
    async pruneRefresh(before) {
      for (const [hash, entry] of tokens) if (entry.chainStartedAt < before) tokens.delete(hash);
    },
    async signingKey(create) {
      key ??= await create();
      return key;
    },
  };
}
