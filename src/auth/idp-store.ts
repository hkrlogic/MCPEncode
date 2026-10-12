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
  /** SHA-256 of the registering address key (IPv6 per /64), for the per-address pending cap. */
  registeredFrom?: string;
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

export type CallbackHostStatus = "pending" | "approved" | "denied";

/** A remote https callback host a site admin approves or denies (migration 017). */
export type CallbackHostRecord = {
  host: string;
  status: CallbackHostStatus;
  firstSeen: number;
  lastSeen: number;
  /** client_name of a client that used this host. Unverified: the client chose it. */
  sampleClientName: string;
  decidedBy: string | null;
  decidedAt: number | null;
};

/** The hostname of an http(s) callback, lowercased, or undefined. */
export function uriHost(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export type IdpStore = {
  saveClient(client: OAuthClient): Promise<void>;
  findClient(clientId: string): Promise<OAuthClient | undefined>;
  /** Drop registrations that never got a refresh token and are older than `before`. */
  pruneClients(before: number): Promise<void>;
  /** Registrations made at or after `since` that have not yet got a refresh token (pending sign-in). */
  countPendingClients(since: number): Promise<number>;
  /** The same, only for registrations made from this address (see OAuthClient.registeredFrom). */
  countPendingClientsFrom(since: number, registeredFrom: string): Promise<number>;
  insertRefresh(record: RefreshRecord): Promise<void>;
  /** Atomically mark an active token used. Reuse of a used token revokes its chain. */
  claimRefresh(tokenHash: string, now: number): Promise<RefreshClaim>;
  revokeChain(chainId: string): Promise<void>;
  /** Sign-out and password changes: every chain this account holds. */
  revokeSubject(sub: string): Promise<void>;
  /** Remove rows whose chain started before `before` (past the maximum lifetime). */
  pruneRefresh(before: number): Promise<void>;
  findHost(host: string): Promise<CallbackHostRecord | undefined>;
  /** Hosts a site admin approved. */
  approvedHosts(): Promise<string[]>;
  listHosts(): Promise<CallbackHostRecord[]>;
  /**
   * Record that a client asked for this host. Existing rows only get last_seen
   * updated. A new row is pending, unless `maxPending` pending rows exist (then "full").
   */
  notePendingHost(input: { host: string; clientName: string; now: number; maxPending: number }): Promise<
    "created" | "seen" | "full"
  >;
  /** Set a host's status (creating the row if needed). */
  decideHost(input: { host: string; status: CallbackHostStatus; by: string; now: number }): Promise<CallbackHostRecord>;
  /** Delete the refresh tokens of every client with a callback on this host. Returns how many were removed. */
  revokeHostTokens(host: string): Promise<number>;
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
  const hosts = new Map<string, CallbackHostRecord>();
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
    async countPendingClientsFrom(since, registeredFrom) {
      const used = new Set([...tokens.values()].map((row) => row.clientId));
      let count = 0;
      for (const [id, client] of clients) {
        if (client.registeredFrom === registeredFrom && client.createdAt >= since && !used.has(id)) count += 1;
      }
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
    async findHost(host) {
      const row = hosts.get(host);
      return row ? { ...row } : undefined;
    },
    async approvedHosts() {
      return [...hosts.values()].filter((row) => row.status === "approved").map((row) => row.host);
    },
    async listHosts() {
      return [...hosts.values()].map((row) => ({ ...row })).sort((a, b) => b.lastSeen - a.lastSeen);
    },
    async notePendingHost({ host, clientName, now, maxPending }) {
      const row = hosts.get(host);
      if (row) {
        row.lastSeen = now;
        if (!row.sampleClientName && clientName) row.sampleClientName = clientName;
        return "seen";
      }
      if ([...hosts.values()].filter((entry) => entry.status === "pending").length >= maxPending) return "full";
      hosts.set(host, {
        host,
        status: "pending",
        firstSeen: now,
        lastSeen: now,
        sampleClientName: clientName,
        decidedBy: null,
        decidedAt: null,
      });
      return "created";
    },
    async decideHost({ host, status, by, now }) {
      const row = hosts.get(host) ?? {
        host,
        status,
        firstSeen: now,
        lastSeen: now,
        sampleClientName: "",
        decidedBy: null,
        decidedAt: null,
      };
      Object.assign(row, { status, decidedBy: by, decidedAt: now });
      hosts.set(host, row);
      return { ...row };
    },
    async revokeHostTokens(host) {
      const affected = new Set(
        [...clients.values()]
          .filter((client) => client.redirectUris.some((uri) => uriHost(uri) === host))
          .map((client) => client.clientId),
      );
      let removed = 0;
      for (const [hash, entry] of tokens) {
        if (affected.has(entry.clientId)) {
          tokens.delete(hash);
          removed += 1;
        }
      }
      return removed;
    },
    async signingKey(create) {
      key ??= await create();
      return key;
    },
  };
}
