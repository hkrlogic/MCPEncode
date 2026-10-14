/** Accounts table. Passwords are stored only as scrypt hashes. */
import {
  checkNewAccount,
  type Account,
  type AccountRole,
  type AccountStore,
  type StoredAccount,
} from "../auth/accounts.ts";
import { hashPassword, normalizeUsername, passwordError } from "../auth/passwords.ts";
import { removeUnusedDefaultLibrary } from "./libraries.ts";
import { getRow } from "./query-helpers.ts";
import type { Database } from "./types.ts";

type AccountRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled?: boolean | number | string;
  sessions_revoked_at?: number | string | null;
};

function asRole(value: string): AccountRole {
  // Legacy edit rows are migrated to sa; still accept them if a restart raced the migration.
  return value === "sa" || value === "edit" ? "sa" : "readonly";
}

function asDisabled(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "t" || value === "true" || value === "1";
}

function toStored(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    username: row.username,
    role: asRole(row.role),
    disabled: asDisabled(row.disabled),
    passwordHash: row.password_hash,
    sessionsRevokedAt:
      row.sessions_revoked_at === null || row.sessions_revoked_at === undefined ? null : Number(row.sessions_revoked_at),
  };
}

function publicAccount(row: StoredAccount): Account {
  return { id: row.id, username: row.username, role: row.role, disabled: row.disabled };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

/**
 * One lock for SA on/off and disable.
 * The check and the update must not interleave, or two requests can each
 * see "someone else is still SA" and then turn both off.
 */
function withSaGuard<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.get("SELECT pg_advisory_xact_lock(hashtext('mcpencode-sa-guard'))");
    return fn(tx);
  });
}

/** Other accounts that can still sign in as SA. Legacy `edit` rows count as SA. */
async function otherActiveSaCount(db: Database, exceptId: string): Promise<number> {
  const row = await getRow<{ n: string | number }>(
    db,
    `SELECT COUNT(*) AS n FROM accounts
     WHERE role IN ('sa', 'edit') AND disabled = FALSE AND id <> ?`,
    exceptId,
  );
  return Number(row?.n ?? 0);
}

export function accountStore(db: Database): AccountStore {
  return {
    async count() {
      const row = await getRow<{ n: string | number }>(db, "SELECT COUNT(*) AS n FROM accounts");
      return Number(row?.n ?? 0);
    },
    async findByUsername(username: string) {
      const row = await getRow<AccountRow>(
        db,
        "SELECT id, username, password_hash, role, disabled, sessions_revoked_at FROM accounts WHERE username = ?",
        normalizeUsername(username),
      );
      return row ? toStored(row) : undefined;
    },
    async findById(id: string) {
      const row = await getRow<AccountRow>(
        db,
        "SELECT id, username, password_hash, role, disabled, sessions_revoked_at FROM accounts WHERE id = ?",
        id,
      );
      return row ? toStored(row) : undefined;
    },
    async createFirst(input) {
      const message = checkNewAccount(input.username, input.password);
      if (message) return { ok: false, message };
      const id = crypto.randomUUID();
      const username = normalizeUsername(input.username);
      const passwordHash = await hashPassword(input.password);
      // Hold a transaction lock so two browsers cannot both become the first account.
      const result = await db.transaction(async (tx) => {
        await tx.get("SELECT pg_advisory_xact_lock(hashtext('mcpencode-accounts'))");
        const existing = await getRow<{ id: string }>(tx, "SELECT id FROM accounts LIMIT 1");
        if (existing) return { ok: false as const, message: "An account already exists. Sign in." };
        await tx.run(
          `INSERT INTO accounts (id, username, password_hash, role, disabled, created_at)
           VALUES (?, ?, ?, 'sa', FALSE, ?)`,
          id,
          username,
          passwordHash,
          Date.now(),
        );
        return {
          ok: true as const,
          account: { id, username, role: "sa" as const, disabled: false },
        };
      });
      if (result.ok) await removeUnusedDefaultLibrary(db).catch(() => undefined);
      return result;
    },
    async list() {
      const rows = (await db.all(
        "SELECT id, username, password_hash, role, disabled FROM accounts ORDER BY LOWER(username) ASC, username ASC",
      )) as AccountRow[];
      return rows.map((row) => publicAccount(toStored(row)));
    },
    async create(input) {
      const message = checkNewAccount(input.username, input.password);
      if (message) return { ok: false, message };
      if (input.role !== "sa" && input.role !== "readonly") {
        return { ok: false, message: "Invalid account admin flag." };
      }
      const account: Account = {
        id: crypto.randomUUID(),
        username: normalizeUsername(input.username),
        role: input.role,
        disabled: false,
      };
      try {
        await db.run(
          `INSERT INTO accounts (id, username, password_hash, role, disabled, created_at)
           VALUES (?, ?, ?, ?, FALSE, ?)`,
          account.id,
          account.username,
          await hashPassword(input.password),
          account.role,
          Date.now(),
        );
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, message: "That username is already in use." };
        throw error;
      }
      return { ok: true, account };
    },
    async setPassword(id, password) {
      const message = passwordError(password);
      if (message) return { ok: false, message };
      const row = await getRow<AccountRow>(
        db,
        "SELECT id, username, password_hash, role, disabled FROM accounts WHERE id = ?",
        id,
      );
      if (!row) return { ok: false, message: "Account not found." };
      if (asDisabled(row.disabled)) {
        return { ok: false, message: "Enable the account before resetting the password." };
      }
      await db.run(
        "UPDATE accounts SET password_hash = ? WHERE id = ?",
        await hashPassword(password),
        id,
      );
      return { ok: true };
    },
    async revokeSessions(id) {
      await db.run("UPDATE accounts SET sessions_revoked_at = ? WHERE id = ?", Date.now(), id);
    },
    async setDisabled(id, disabled) {
      return withSaGuard(db, async (tx) => {
        const row = await getRow<AccountRow>(
          tx,
          "SELECT id, username, password_hash, role, disabled FROM accounts WHERE id = ?",
          id,
        );
        if (!row) return { ok: false as const, message: "Account not found." };
        if (disabled && asRole(row.role) === "sa" && (await otherActiveSaCount(tx, id)) <= 0) {
          return { ok: false as const, message: "Keep at least one active SA account." };
        }
        await tx.run("UPDATE accounts SET disabled = ? WHERE id = ?", disabled, id);
        const updated = toStored({ ...row, disabled });
        return { ok: true as const, account: publicAccount(updated) };
      });
    },
    async setSa(id, sa) {
      return withSaGuard(db, async (tx) => {
        const row = await getRow<AccountRow>(
          tx,
          "SELECT id, username, password_hash, role, disabled FROM accounts WHERE id = ?",
          id,
        );
        if (!row) return { ok: false as const, message: "Account not found." };
        // Turning SA off must leave another account that can still sign in as SA.
        if (!sa && asRole(row.role) === "sa" && (await otherActiveSaCount(tx, id)) <= 0) {
          return { ok: false as const, message: "Keep at least one active SA account." };
        }
        const role: AccountRole = sa ? "sa" : "readonly";
        await tx.run("UPDATE accounts SET role = ? WHERE id = ?", role, id);
        return { ok: true as const, account: publicAccount(toStored({ ...row, role })) };
      });
    },
  };
}
