import { AuthStatus } from "../features/auth/auth-types";

export type AppFrameDecision =
  | { mode: "loading" }
  | { mode: "bare" }
  | { mode: "shell" }
  | { mode: "redirect"; destination: "/login" | "/dashboard" | "/account-setup" | "/forbidden" };

export function appFrameDecision(
  status: AuthStatus,
  pathname: string,
  canRead: boolean
): AppFrameDecision {
  if (status === "loading") return { mode: "loading" };

  if (status === "not-provisioned") {
    return pathname === "/forbidden"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/forbidden" };
  }

  if (status === "onboarding") {
    return pathname === "/account-setup"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/account-setup" };
  }

  if (status === "anonymous") {
    return pathname === "/login" || pathname === "/forbidden"
      ? { mode: "bare" }
      : { mode: "redirect", destination: "/login" };
  }

  if (pathname === "/login" || pathname === "/account-setup") {
    return { mode: "redirect", destination: "/dashboard" };
  }
  if (!canRead && pathname !== "/forbidden") {
    return { mode: "redirect", destination: "/forbidden" };
  }
  return { mode: "shell" };
}
