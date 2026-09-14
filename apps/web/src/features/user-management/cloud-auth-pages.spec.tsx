// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InvitationAcceptPage from "../../app/invite/accept/page";
import CompleteInvitationPage from "../../app/complete-invitation/page";
import LoginPage from "../../app/login/page";
import UsersPage from "../../app/settings/users/page";
import { AuthContext, AuthContextValue } from "../auth/auth-context";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  request: vi.fn()
}));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/features/auth/auth-provider", () => ({
  WEB_AUTH_PROVIDERS: ["supabase", "local"],
  WEB_AUTH_PROVIDER: "supabase",
  parseWebAuthProvider: (value: string | undefined) => value ?? "local",
  authLoginPayload: (identifier: string, password: string) => ({ email: identifier, password })
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  apiGet: apiMocks.get,
  apiPatch: apiMocks.patch,
  apiRequest: apiMocks.request
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace })
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/invite/accept");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Supabase Auth web experience", () => {
  it("uses an email login field while retaining the two-field login boundary", () => {
    const auth = authValue("anonymous", []);
    renderWithAuth(<LoginPage />, auth);

    const email = screen.getByLabelText("이메일");
    expect(email.getAttribute("type")).toBe("email");
    expect(screen.queryByLabelText("사용자 이름")).toBeNull();
    expect(screen.getAllByRole("textbox").concat(screen.getByLabelText("비밀번호"))).toHaveLength(2);

    fireEvent.change(email, { target: { value: "user@example.test" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password" } });
    fireEvent.submit(screen.getByRole("button", { name: "로그인" }).closest("form")!);
    expect(auth.login).toHaveBeenCalledWith("user@example.test", "password");
  });

  it("accepts only the fragment invitation link and never offers manual setup-code input", async () => {
    renderWithAuth(<InvitationAcceptPage />, authValue("anonymous", []));

    expect(await screen.findByRole("heading", { name: "업무 계정 초대 확인" })).toBeTruthy();
    expect(screen.queryByLabelText("일회용 설정 코드")).toBeNull();
    expect(document.body.textContent).not.toContain("코드 준비");

    cleanup();
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    renderWithAuth(<InvitationAcceptPage />, authValue("anonymous", []));
    expect(await screen.findByRole("button", { name: "초대 수락" })).toBeTruthy();
  });

  it("explains missing invitation information without misleading acceptance instructions", () => {
    renderWithAuth(<InvitationAcceptPage />, authValue("anonymous", []));
    expect(screen.getByRole("alert").textContent).toContain("초대 확인 정보가 없습니다");
    expect(document.body.textContent).not.toContain("아래 버튼을 눌러야");
  });

  it("passes recovery only after explicit acceptance and removes the fragment", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    window.history.replaceState(null, "", `/invite/accept#token_hash=${token}&token_type=recovery`);
    const auth = authValue("anonymous", []);
    renderWithAuth(<InvitationAcceptPage />, auth);
    expect(window.location.hash).toBe("");
    expect(auth.acceptInvitation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    await waitFor(() => expect(auth.acceptInvitation).toHaveBeenCalledWith(token, "recovery"));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/complete-invitation"));
  });

  it("describes email login after invitation completion", () => {
    renderWithAuth(<CompleteInvitationPage />, authValue("onboarding", []));
    expect(screen.getByText("설정이 완료되면 이메일과 비밀번호로 로그인합니다.")).toBeTruthy();
  });

  it("sends an email invitation and never renders a setup token or local reset action", async () => {
    const leakedSetupToken = "S".repeat(43);
    apiMocks.get.mockResolvedValue({
      items: [userSummary({
        email: "existing@example.test",
        setupToken: leakedSetupToken,
        inviteStatus: "INVITED",
        reconciliationActions: ["RETRY_INVITATION", "CANCEL"]
      })]
    });
    apiMocks.request.mockResolvedValue(userSummary({
      id: "new-user",
      email: "new@example.test",
      setupToken: leakedSetupToken
    }));
    renderPage(<UsersPage />, authValue("authenticated", ["users.manage"]));

    expect(await screen.findByText("existing@example.test")).toBeTruthy();
    expect(screen.getByText("초대 발송됨")).toBeTruthy();
    expect(screen.getByRole("button", { name: "재초대" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "초대 취소" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "비밀번호 재설정" })).toBeNull();
    expect(screen.queryByLabelText("사용자 이름")).toBeNull();
    expect(document.body.textContent).not.toContain(leakedSetupToken);

    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: " New@Example.Test " } });
    fireEvent.change(screen.getAllByLabelText("이름")[0], { target: { value: " 새 사용자 " } });
    fireEvent.click(screen.getByRole("button", { name: "초대 보내기" }));

    await waitFor(() => expect(apiMocks.request).toHaveBeenCalledWith(
      "/users/invitations",
      expect.objectContaining({ body: { email: "new@example.test", name: "새 사용자", role: "GUEST" } })
    ));
    expect(document.body.textContent).not.toContain(leakedSetupToken);
    expect(document.body.textContent).not.toContain("일회용 설정 코드");
  });
});

function renderWithAuth(children: ReactNode, value: AuthContextValue) {
  return render(<AuthContext.Provider value={value}>{children}</AuthContext.Provider>);
}

function renderPage(children: ReactNode, auth: AuthContextValue) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </QueryClientProvider>
  );
}

function authValue(
  status: AuthContextValue["status"],
  permissions: AuthContextValue["permissions"]
): AuthContextValue {
  const granted = new Set(permissions);
  return {
    user: status === "authenticated"
      ? { id: "admin", username: null, email: "admin@example.test", name: "Admin", role: "SUPER_ADMIN", isActive: true, inviteStatus: "ACTIVE" }
      : null,
    permissions,
    isLoading: status === "loading",
    isAuthenticated: status === "authenticated",
    status,
    login: vi.fn().mockResolvedValue(undefined),
    acceptInvitation: vi.fn(),
    completeInvitation: vi.fn(),
    logout: vi.fn(),
    can: (permission) => granted.has(permission),
    refreshAuth: vi.fn(async () => null)
  } as AuthContextValue;
}

function userSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: null,
    email: "user@example.test",
    name: "기존 사용자",
    role: "USER",
    isActive: true,
    inviteStatus: "ACTIVE",
    reconciliationActions: [],
    lastLoginAt: null,
    invitedAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides
  };
}
