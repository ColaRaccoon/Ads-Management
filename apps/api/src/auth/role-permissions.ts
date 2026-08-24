import { AppRole } from "@prisma/client";

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

export const ROLE_PERMISSIONS: Readonly<Record<AppRole, readonly Permission[]>> = {
  [AppRole.SUPER_ADMIN]: PERMISSIONS,
  [AppRole.ADMIN]: [
    "data.read",
    "change_logs.create",
    "reports.generate",
    "products.manage",
    "imports.manage",
    "mappings.manage",
    "operations.run"
  ],
  [AppRole.USER]: ["data.read", "change_logs.create", "reports.generate"],
  [AppRole.GUEST]: ["data.read"]
};

export function permissionsForRole(role: AppRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
