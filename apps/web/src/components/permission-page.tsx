"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Permission } from "@/features/auth/auth-types";
import { useCan } from "@/features/auth/use-auth";

export function PermissionPage({ permission, children }: { permission: Permission; children: ReactNode }) {
  const canAccess = useCan(permission);
  const router = useRouter();

  useEffect(() => {
    if (!canAccess) router.replace("/forbidden");
  }, [canAccess, router]);

  if (!canAccess) {
    return (
      <section className="page" aria-busy="true" aria-live="polite">
        <div className="panel">권한을 확인하고 있습니다.</div>
      </section>
    );
  }
  return children;
}
