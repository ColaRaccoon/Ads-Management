import { AuthStatus } from "../features/auth/auth-types";

export type AppFrameDecision =
  | { mode: "loading" }
  | { mode: "bare" }
  | { mode: "shell" }
  | { mode: "redirect"; destination: "/login" | "/dashboard" | "/complete-invitation" | "/forbidden" };

export function appFrameDecision(
  status: AuthStatus,
  pathname: string,
  canRead: boolean
): AppFrameDecision {
  // Mount the fragment-bearing landing before /auth/me settles so it can
  // remove the one-time value from the visible URL immediately.
  if (pathname === "/invite/accept") return { mode: "bare" };

  if (pathname === "/complete-invitation" && (status === "loading" || status === "onboarding")) {
    return { mode: "bare" };
  }

  if (status === "loading") return pathname === "/login" ? { mode: "bare" } : { mode: "loading" };

  if (status === "not-provisioned") {
    return pathname === "/forbidden"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/forbidden" };
  }

  if (status === "onboarding") {
    return pathname === "/complete-invitation"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/complete-invitation" };
  }

  if (status === "anonymous") {
    return pathname === "/login" || pathname === "/forbidden"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/login" };
  }

  if (pathname === "/login" || pathname === "/account-setup" || pathname === "/complete-invitation") {
    return { mode: "redirect", destination: "/dashboard" };
  }
  if (!canRead && pathname !== "/forbidden") {
    return { mode: "redirect", destination: "/forbidden" };
  }
  return { mode: "shell" };
}
