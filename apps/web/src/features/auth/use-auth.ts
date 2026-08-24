"use client";

import { useContext } from "react";
import { AuthContext } from "./auth-context";
import { Permission } from "./auth-types";

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}

export function useCan(permission: Permission) {
  return useAuth().can(permission);
}
