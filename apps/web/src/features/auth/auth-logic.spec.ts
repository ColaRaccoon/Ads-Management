import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { appFrameDecision } from "../../components/app-frame-state";
import { clearUserQueries } from "./auth-cache";
import { loginRedirect, safeNextPath } from "./auth-redirect";
import { hasPermission, parseAuthMe, roleLabel } from "./auth-types";

describe("authentication and permission logic", () => {
  it("accepts only server-returned known permissions and uses role only as a label", () => {
    const me = parseAuthMe({
      user: { id: "u1", email: "user@example.test", name: "User", role: "ADMIN", isActive: true, inviteStatus: "ACTIVE" },
      permissions: ["data.read", "imports.manage", "imports.manage"],
      authorizationVersion: "opaque-version"
    });

    expect(me.permissions).toEqual(["data.read", "imports.manage"]);
    expect(hasPermission(me.permissions, "imports.manage")).toBe(true);
    expect(hasPermission(me.permissions, "users.manage")).toBe(false);
    expect(roleLabel(me.user.role)).toBe("관리자");
  });

  it("rejects unknown permission data instead of deriving permissions from a role", () => {
    expect(() => parseAuthMe({
      user: { id: "u1", email: null, name: "User", role: "SUPER_ADMIN", isActive: true, inviteStatus: "ACTIVE" },
      permissions: ["everything.manage"],
      authorizationVersion: "opaque-version"
    })).toThrow("Invalid authentication response");
  });

  it.each([
    ["https://evil.test", "/dashboard"],
    ["//evil.test/path", "/dashboard"],
    ["/\\evil.test/path", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["/login", "/dashboard"],
    ["/account-setup?next=/sales", "/dashboard"],
    ["/complete-invitation", "/dashboard"],
    ["/invite/accept#token_hash=never-a-next-value", "/dashboard"],
    ["/forbidden", "/dashboard"],
    ["/sales?from=2026-08-01#table", "/sales?from=2026-08-01#table"]
  ])("validates post-login next path %s", (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });

  it("encodes a protected internal path in the login redirect", () => {
    expect(loginRedirect("/sales", "?from=2026-08-01&to=2026-08-24"))
      .toBe("/login?next=%2Fsales%3Ffrom%3D2026-08-01%26to%3D2026-08-24");
  });

  it("never renders business UI while loading, anonymous, or onboarding", () => {
    expect(appFrameDecision("loading", "/dashboard", false)).toEqual({ mode: "loading" });
    expect(appFrameDecision("anonymous", "/dashboard", false)).toEqual({ mode: "redirect", destination: "/login" });
    expect(appFrameDecision("anonymous", "/login", false)).toEqual({ mode: "bare" });
    expect(appFrameDecision("anonymous", "/invite/accept", false)).toEqual({ mode: "bare" });
    expect(appFrameDecision("loading", "/invite/accept", false)).toEqual({ mode: "bare" });
    expect(appFrameDecision("onboarding", "/dashboard", false)).toEqual({ mode: "redirect", destination: "/complete-invitation" });
    expect(appFrameDecision("onboarding", "/complete-invitation", false)).toEqual({ mode: "bare" });
    expect(appFrameDecision("loading", "/complete-invitation", false)).toEqual({ mode: "bare" });
    expect(appFrameDecision("authenticated", "/dashboard", true)).toEqual({ mode: "shell" });
  });

  it("removes every user cache while preserving the central auth query during authz sync", () => {
    const client = new QueryClient();
    client.setQueryData(["auth", "me"], { authorizationVersion: "v2" });
    client.setQueryData(["products"], [{ id: "p1" }]);
    client.setQueryData(["reports", "daily"], { secret: "cached" });

    clearUserQueries(client);

    expect(client.getQueryData(["auth", "me"])).toEqual({ authorizationVersion: "v2" });
    expect(client.getQueryData(["products"])).toBeUndefined();
    expect(client.getQueryData(["reports", "daily"])).toBeUndefined();
  });
});
