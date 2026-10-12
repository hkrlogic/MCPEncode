/**
 * App roles (readonly / sa) gate sign-in powers: accounts, add libraries, hard-delete.
 * Library roles (reader / publisher) gate what someone may do inside one library.
 * SA bypasses the access list and holds every permission.
 * Permissions are what tools and HTTP routes check.
 */
export const PERMISSIONS = [
  "records.read",
  "records.write",
  "records.delete",
  "libraries.create",
  "libraries.delete",
  "accounts.manage",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
/** App-level role from the identity provider / accounts table. */
export type Role = "readonly" | "sa";
/** Role on one library's access list. Independent of the app role. */
export type LibraryRole = "reader" | "publisher";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // The audit log names people and items. Readers do not get it.
  readonly: ["records.read"],
  sa: [
    "records.read",
    "records.write",
    "records.delete",
    "libraries.create",
    "libraries.delete",
    "accounts.manage",
    "audit.read",
  ],
};

/** Publishers archive and run a library; only SA hard-deletes items. */
export const LIBRARY_ROLE_PERMISSIONS: Record<LibraryRole, readonly Permission[]> = {
  reader: ["records.read"],
  publisher: ["records.read", "audit.read", "records.write", "libraries.delete"],
};

export type Access = {
  sub: string;
  clientId: string;
  role: Role;
  permissions: readonly Permission[];
  /** Set when this access is scoped to one library's access list (or SA override). */
  libraryRole?: LibraryRole;
};

export function can(access: Access, permission: Permission): boolean {
  return access.permissions.includes(permission);
}

export function isSa(access: Pick<Access, "role">): boolean {
  return access.role === "sa";
}

/** Map a library access-list role onto the Access shape handlers already check. */
export function accessFromLibraryRole(input: {
  sub: string;
  clientId: string;
  libraryRole: LibraryRole;
}): Access {
  return {
    sub: input.sub,
    clientId: input.clientId,
    // Display/app role stays readonly here; libraryRole carries publisher/reader.
    role: "readonly",
    libraryRole: input.libraryRole,
    permissions: LIBRARY_ROLE_PERMISSIONS[input.libraryRole],
  };
}

/**
 * Effective access inside one library.
 * SA always gets full powers; everyone else uses their access-list role.
 */
export function accessForLibrary(input: {
  sub: string;
  clientId: string;
  idpRole: Role;
  libraryRole?: LibraryRole;
}): Access | undefined {
  if (input.idpRole === "sa") {
    return {
      ...accessFromIdentity({ sub: input.sub, clientId: input.clientId, role: "sa" }),
      libraryRole: input.libraryRole ?? "publisher",
    };
  }
  if (!input.libraryRole) return undefined;
  return accessFromLibraryRole({
    sub: input.sub,
    clientId: input.clientId,
    libraryRole: input.libraryRole,
  });
}

/**
 * Resolve exactly one role from token scopes and/or IdP role names.
 * SA wins if both appear. Unknown tokens have no role.
 * Legacy mpos:edit / mpos-editor names still mean SA.
 */
export function resolveRole(claims: {
  scopes: string[];
  roles: string[];
}): Role | undefined {
  const names = new Set(
    [...claims.scopes, ...claims.roles].map((value) => value.toLowerCase()),
  );
  if (
    names.has("mpos:sa") ||
    names.has("mpos-sa") ||
    names.has("mpos:edit") ||
    names.has("mpos-editor") ||
    names.has("mpos-edit")
  ) {
    return "sa";
  }
  if (
    names.has("mpos:readonly") ||
    names.has("mpos-readonly") ||
    names.has("mpos-reader")
  ) {
    return "readonly";
  }
  return undefined;
}

export function accessFromIdentity(input: {
  sub: string;
  clientId: string;
  role: Role;
}): Access {
  return {
    sub: input.sub,
    clientId: input.clientId,
    role: input.role,
    permissions: ROLE_PERMISSIONS[input.role],
  };
}
