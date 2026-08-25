// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React, { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsersPage from "../../app/settings/users/page";
import SecurityAuditPage from "../../app/settings/security-audit/page";
import { AuthContext, AuthContextValue } from "../auth/auth-context";
import { ApiError } from "@/lib/api";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  request: vi.fn()
}));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  apiGet: apiMocks.get,
  apiPatch: apiMocks.patch,
  apiRequest: apiMocks.request
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace })
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("super-admin management pages", () => {
  it.each([
    [<UsersPage key="users" />, "users.manage"],
    [<SecurityAuditPage key="audit" />, "audit.read"]
  ] as const)("redirects a direct URL without mounting its protected query", async (page, _permission) => {
    renderPage(page, authValue([]));

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/forbidden"));
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it("renders only safe user fields and no provider/session values", async () => {
    apiMocks.get.mockResolvedValue({ items: [userSummary({
      authUserId: "provider-subject-never-render",
      sessionId: "session-never-render",
      providerToken: "token-never-render"
    })] });
    renderPage(<UsersPage />, authValue(["users.manage"]));

    expect(await screen.findByText("user@example.test")).toBeTruthy();
    expect(screen.getByText("활성화 완료")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/provider-subject-never-render|session-never-render|token-never-render/);
  });

  it("reuses one UUID idempotency key only for an explicit retry of the same invitation", async () => {
    apiMocks.get.mockResolvedValue({ items: [] });
    apiMocks.request
      .mockRejectedValueOnce(new ApiError(503, "raw provider error", "INVITATION_PROVIDER_UNAVAILABLE"))
      .mockResolvedValueOnce(userSummary());
    renderPage(<UsersPage />, authValue(["users.manage"]));
    await screen.findByText("등록된 사용자가 없습니다.");

    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: " NEW@Example.Test " } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: " 새 사용자 " } });
    fireEvent.click(screen.getByRole("button", { name: "초대 보내기" }));

    expect(await screen.findByText(/초대 제공자와 통신하지 못했습니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "같은 요청 다시 시도" }));
    await waitFor(() => expect(apiMocks.request).toHaveBeenCalledTimes(2));
    const first = apiMocks.request.mock.calls[0][1];
    const second = apiMocks.request.mock.calls[1][1];
    expect(first.body).toEqual({ email: "new@example.test", name: "새 사용자", role: "GUEST" });
    expect(first.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.headers["Idempotency-Key"]).toBe(first.headers["Idempotency-Key"]);
  });

  it("patches only changed lifecycle fields and refreshes the current authorization", async () => {
    apiMocks.get.mockResolvedValue({ items: [userSummary()] });
    apiMocks.patch.mockResolvedValue(userSummary({ name: "변경 이름", role: "ADMIN" }));
    const auth = authValue(["users.manage"], "user-1");
    renderPage(<UsersPage />, auth);
    await screen.findByText("user@example.test");

    fireEvent.change(screen.getAllByLabelText("이름")[1], { target: { value: " 변경 이름 " } });
    fireEvent.change(screen.getAllByLabelText("역할", { selector: "select" })[1], { target: { value: "ADMIN" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledWith("/users/user-1", { name: "변경 이름", role: "ADMIN" }));
    await waitFor(() => expect(auth.refreshAuth).toHaveBeenCalledTimes(1));
  });

  it("renders reconciliation controls only from the server allowlist", async () => {
    apiMocks.get.mockResolvedValue({
      items: [
        userSummary({
          id: "pending-stale",
          email: "pending@example.test",
          inviteStatus: "PENDING_PROVIDER",
          reconciliationActions: ["CANCEL"]
        }),
        userSummary({
          id: "local-failure",
          email: "local-failure@example.test",
          inviteStatus: "RECONCILE_REQUIRED",
          reconciliationActions: ["CANCEL"]
        }),
        userSummary({
          id: "password-pending",
          email: "password-pending@example.test",
          inviteStatus: "VERIFIED_PENDING_PASSWORD",
          reconciliationActions: ["CANCEL"]
        })
      ]
    });
    renderPage(<UsersPage />, authValue(["users.manage"]));

    for (const email of ["pending@example.test", "local-failure@example.test"]) {
      const card = (await screen.findByText(email)).closest("article");
      expect(card).toBeTruthy();
      expect(within(card!).queryByRole("button", { name: "재초대" })).toBeNull();
      expect(within(card!).getByRole("button", { name: "초대 취소" })).toBeTruthy();
    }
    const onboardingCard = (await screen.findByText("password-pending@example.test")).closest("article");
    expect(onboardingCard).toBeTruthy();
    expect(within(onboardingCard!).getByRole("button", { name: "초대 취소" })).toBeTruthy();
  });

  it("renders bounded safe audit summaries and encodes filters/cursors", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes("cursor=next%2Bopaque")) return { items: [], nextCursor: null };
      return {
        items: [{
          id: "audit-1",
          actorUserId: "actor-1",
          actorType: "USER",
          action: "USER_ROLE_CHANGED",
          targetType: "AppUser",
          targetId: "user-1",
          result: "SUCCESS",
          beforeJson: { role: "GUEST", tokenHash: "never-render-hash" },
          afterJson: { role: "USER", password: "never-render-password" },
          requestId: "request-1",
          createdAt: "2026-08-25T00:00:00.000Z"
        }],
        nextCursor: "next+opaque"
      };
    });
    renderPage(<SecurityAuditPage />, authValue(["audit.read"]));

    expect(await screen.findByText("역할: 게스트 → 사용자")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/never-render-hash|never-render-password/);
    fireEvent.change(screen.getByLabelText("작업"), { target: { value: "USER_ROLE_CHANGED" } });
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "필터 적용" }));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith(expect.stringContaining("action=USER_ROLE_CHANGED")));
    expect(apiMocks.get).toHaveBeenCalledWith(expect.stringContaining("limit=50"));
    fireEvent.click(await screen.findByRole("button", { name: "다음 기록 50개" }));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith(expect.stringContaining("cursor=next%2Bopaque")));
  });
});

function renderPage(children: ReactNode, auth: AuthContextValue) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </QueryClientProvider>
  );
}

function authValue(permissions: AuthContextValue["permissions"], id = "admin-user"): AuthContextValue {
  const granted = new Set(permissions);
  return {
    user: { id, email: "admin@example.test", name: "Admin", role: "SUPER_ADMIN", isActive: true, inviteStatus: "ACTIVE" },
    permissions,
    isLoading: false,
    isAuthenticated: true,
    status: "authenticated",
    login: vi.fn(),
    acceptInvitation: vi.fn(),
    completeInvitation: vi.fn(),
    logout: vi.fn(),
    can: (permission) => granted.has(permission),
    refreshAuth: vi.fn(async () => null)
  };
}

function userSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.test",
    name: "기존 이름",
    role: "USER",
    isActive: true,
    inviteStatus: "ACTIVE",
    reconciliationActions: [],
    lastLoginAt: "2026-08-25T00:00:00.000Z",
    invitedAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides
  };
}
