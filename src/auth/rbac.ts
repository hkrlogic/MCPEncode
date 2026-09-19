/**
 * Roles are what people are assigned in the identity provider.
 * Permissions are what tools and HTTP routes check. Adding a third role
 * later is a new row in ROLE_PERMISSIONS, not a rewrite of handlers.
 */
export const PERMISSIONS = ["records.read", "records.write", "records.delete", "audit.read"] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "readonly" | "edit";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  readonly: ["records.read", "audit.read"],
  edit: ["records.read", "audit.read", "records.write", "records.delete"],
};

export type Access = {
  sub: string;
  clientId: string;
  role: Role;
  permissions: readonly Permission[];
};

export function can(access: Access, permission: Permission): boolean {
  return access.permissions.includes(permission);
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
