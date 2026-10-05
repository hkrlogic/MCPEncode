/**
 * IdP roles (readonly / edit) gate sign-in and adding libraries.
 * Library roles (reader / publisher) gate what someone may do inside one library.
 * Permissions are what tools and HTTP routes check.
 */
export const PERMISSIONS = ["records.read", "records.write", "records.delete", "audit.read"] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "readonly" | "edit";
/** Role on one library's access list. Independent of the IdP role. */
export type LibraryRole = "reader" | "publisher";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  readonly: ["records.read", "audit.read"],
  edit: ["records.read", "audit.read", "records.write", "records.delete"],
};

export const LIBRARY_ROLE_PERMISSIONS: Record<LibraryRole, readonly Permission[]> = {
  reader: ["records.read", "audit.read"],
  publisher: ["records.read", "audit.read", "records.write", "records.delete"],
};

export type Access = {
  sub: string;
  clientId: string;
  role: Role;
  permissions: readonly Permission[];
  /** Set when this access is scoped to one library's access list. */
  libraryRole?: LibraryRole;
};

export function can(access: Access, permission: Permission): boolean {
  return access.permissions.includes(permission);
}

/** Map a library access-list role onto the Access shape handlers already check. */
export function accessFromLibraryRole(input: {
  sub: string;
  clientId: string;
  libraryRole: LibraryRole;
}): Access {
  const role: Role = input.libraryRole === "publisher" ? "edit" : "readonly";
  return {
    sub: input.sub,
    clientId: input.clientId,
    role,
    libraryRole: input.libraryRole,
    permissions: LIBRARY_ROLE_PERMISSIONS[input.libraryRole],
  };
}

/**
 * Resolve exactly one role from token scopes and/or IdP role names.
 * Edit wins if both appear. Unknown tokens have no role.
 */
export function resolveRole(claims: {
  scopes: string[];
  roles: string[];
}): Role | undefined {
  const names = new Set(
    [...claims.scopes, ...claims.roles].map((value) => value.toLowerCase()),
  );
  if (names.has("mpos:edit") || names.has("mpos-editor") || names.has("mpos-edit")) {
    return "edit";
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
