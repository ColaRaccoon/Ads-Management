"use client";

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect } from "react";
import { loginRedirect, safeNextPath } from "@/features/auth/auth-redirect";
import { useAuth } from "@/features/auth/use-auth";
import { AppShell } from "./app-shell";
import { appFrameDecision } from "./app-frame-state";

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const auth = useAuth();
  const decision = appFrameDecision(auth.status, pathname, auth.can("data.read"));

  useEffect(() => {
    if (decision.mode !== "redirect") return;
    if (decision.destination === "/login") {
      const search = typeof window === "undefined" ? "" : window.location.search;
      router.replace(loginRedirect(pathname, search));
      return;
    }
    if (pathname === "/login" && decision.destination === "/dashboard") {
      const next = typeof window === "undefined"
        ? "/dashboard"
        : safeNextPath(new URLSearchParams(window.location.search).get("next"));
      router.replace(next);
      return;
    }
    router.replace(decision.destination);
  }, [decision, pathname, router]);

  useEffect(() => {
    if (decision.mode !== "shell") return;
    auth.refreshAuth();
    // Protected route entry is an explicit authorization revalidation point;
    // React Query deduplicates it with focus/reconnect refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (decision.mode === "loading" || decision.mode === "redirect") {
    return (
      <main className="auth-screen" aria-busy="true" aria-live="polite">
        <div className="auth-card auth-loading">인증 상태를 확인하고 있습니다.</div>
      </main>
    );
  }
  if (decision.mode === "bare") return children;
  return <AppShell>{children}</AppShell>;
}
