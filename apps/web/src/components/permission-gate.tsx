"use client";

import { ReactNode } from "react";
import { Permission } from "@/features/auth/auth-types";
import { useCan } from "@/features/auth/use-auth";

export function PermissionGate({
  permission,
  children,
  fallback = null
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(permission) ? children : fallback;
}
