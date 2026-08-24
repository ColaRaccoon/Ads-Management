export const PERMISSIONS = [
  "data.read",
  "change_logs.create",
  "reports.generate",
  "products.manage",
  "imports.manage",
  "mappings.manage",
  "operations.run",
  "settings.manage",
  "users.manage",
  "audit.read"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const APP_ROLES = ["SUPER_ADMIN", "ADMIN", "USER", "GUEST"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export type AuthUser = {
  id: string;
  email: string | null;
  name: string;
  role: AppRole;
  isActive: boolean;
};

export type AuthMe = {
  user: AuthUser;
  permissions: Permission[];
  authorizationVersion: string;
};

export type AuthStatus =
  | "loading"
  | "anonymous"
  | "authenticated"
  | "onboarding"
  | "not-provisioned";

const permissionSet = new Set<string>(PERMISSIONS);
const roleSet = new Set<string>(APP_ROLES);

const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: "총관리자",
  ADMIN: "관리자",
  USER: "사용자",
  GUEST: "게스트"
};

export function hasPermission(permissions: readonly Permission[], permission: Permission) {
  return permissions.includes(permission);
}

export function roleLabel(role: AppRole | undefined) {
  return role ? ROLE_LABELS[role] : "";
}

export function parseAuthMe(value: unknown): AuthMe {
  if (!isRecord(value) || !isRecord(value.user)) {
    throw new Error("Invalid authentication response.");
  }
  const user = value.user;
  const permissions = value.permissions;
  const authorizationVersion = value.authorizationVersion;
  if (
    typeof user.id !== "string" || user.id.length === 0 ||
    (typeof user.email !== "string" && user.email !== null) ||
    typeof user.name !== "string" ||
    typeof user.role !== "string" || !roleSet.has(user.role) ||
    typeof user.isActive !== "boolean" ||
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== "string" || !permissionSet.has(permission)) ||
    typeof authorizationVersion !== "string" || authorizationVersion.length === 0
  ) {
    throw new Error("Invalid authentication response.");
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as AppRole,
      isActive: user.isActive
    },
    permissions: [...new Set(permissions as Permission[])],
    authorizationVersion
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
