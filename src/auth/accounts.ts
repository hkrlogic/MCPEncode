/**
 * Sign-in accounts. The built-in identity provider uses this store.
 * Postgres is the production store. Tests use the in-memory one.
 */
import { hashPassword, normalizeUsername, passwordError, usernameError } from "./passwords.ts";

export type AccountRole = "sa" | "readonly";

export type Account = {
  id: string;
  username: string;
  role: AccountRole;
  /** When true, sign-in is rejected. Access grants stay until removed. */
  disabled: boolean;
};

export type StoredAccount = Account & { passwordHash: string };

export type AccountStore = {
  count(): Promise<number>;
  findByUsername(username: string): Promise<StoredAccount | undefined>;
  findById(id: string): Promise<StoredAccount | undefined>;
  /** Succeeds only while no account exists. The first account is SA. */
  createFirst(input: {
    username: string;
    password: string;
  }): Promise<{ ok: true; account: Account } | { ok: false; message: string }>;
  list(): Promise<Account[]>;
  create(input: {
    username: string;
    password: string;
    role: AccountRole;
  }): Promise<{ ok: true; account: Account } | { ok: false; message: string }>;
  setPassword(id: string, password: string): Promise<{ ok: true } | { ok: false; message: string }>;
  setDisabled(
    id: string,
    disabled: boolean,
  ): Promise<{ ok: true; account: Account } | { ok: false; message: string }>;
};

export function checkNewAccount(username: string, password: string): string | undefined {
  return usernameError(normalizeUsername(username)) ?? passwordError(password);
}

function publicAccount(row: StoredAccount): Account {
  return { id: row.id, username: row.username, role: row.role, disabled: row.disabled };
}

/** Empty store for tests and for mounting the identity provider without Postgres. */
export function memoryAccountStore(): AccountStore {
  const rows: StoredAccount[] = [];
  return {
    async count() {
      return rows.length;
    },
    async findByUsername(username: string) {
      const key = normalizeUsername(username);
      return rows.find((row) => row.username === key);
    },
    async findById(id: string) {
      return rows.find((row) => row.id === id);
    },
    async createFirst(input) {
      const message = checkNewAccount(input.username, input.password);
      if (message) return { ok: false, message };
      if (rows.length > 0) return { ok: false, message: "An account already exists. Sign in." };
      const account = await pushAccount(rows, input.username, input.password, "sa");
      return { ok: true, account };
    },
    async list() {
      return rows.map(publicAccount);
    },
    async create(input) {
      const message = checkNewAccount(input.username, input.password);
      if (message) return { ok: false, message };
      if (input.role !== "sa" && input.role !== "readonly") {
        return { ok: false, message: "Choose SA or Reader for this account." };
      }
      if (rows.some((row) => row.username === normalizeUsername(input.username))) {
        return { ok: false, message: "That username is already in use." };
      }
      const account = await pushAccount(rows, input.username, input.password, input.role);
      return { ok: true, account };
    },
    async setPassword(id, password) {
      const message = passwordError(password);
      if (message) return { ok: false, message };
      const row = rows.find((entry) => entry.id === id);
      if (!row) return { ok: false, message: "Account not found." };
      if (row.disabled) return { ok: false, message: "Enable the account before resetting the password." };
      row.passwordHash = await hashPassword(password);
      return { ok: true };
    },
    async setDisabled(id, disabled) {
      const row = rows.find((entry) => entry.id === id);
      if (!row) return { ok: false, message: "Account not found." };
      if (disabled && row.role === "sa") {
        const activeSa = rows.filter((entry) => entry.role === "sa" && !entry.disabled && entry.id !== id);
        if (activeSa.length === 0) {
          return { ok: false, message: "Keep at least one active SA account." };
        }
      }
      row.disabled = disabled;
      return { ok: true, account: publicAccount(row) };
    },
  };
}

async function pushAccount(
  rows: StoredAccount[],
  username: string,
  password: string,
  role: AccountRole,
): Promise<Account> {
  const account: StoredAccount = {
    id: crypto.randomUUID(),
    username: normalizeUsername(username),
    role,
    disabled: false,
    passwordHash: await hashPassword(password),
  };
  rows.push(account);
  return publicAccount(account);
}
