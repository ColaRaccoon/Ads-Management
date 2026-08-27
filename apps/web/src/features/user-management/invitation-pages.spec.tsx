// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InvitationAcceptPage from "../../app/invite/accept/page";
import CompleteInvitationPage from "../../app/complete-invitation/page";
import LoginPage from "../../app/login/page";
import { AuthContext, AuthContextValue } from "../auth/auth-context";
import { ApiError } from "@/lib/api";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace })
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/invite/accept");
});

afterEach(() => {
  cleanup();
  navigation.replace.mockReset();
  vi.restoreAllMocks();
});

describe("one-time invitation pages", () => {
  it("strips the fragment once under StrictMode and never submits on landing", async () => {
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const auth = authValue("anonymous");

    renderWithAuth(<StrictMode><InvitationAcceptPage /></StrictMode>, auth);

    expect(await screen.findByRole("button", { name: "설정 코드 수락" })).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(document.body.textContent).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(auth.acceptInvitation).not.toHaveBeenCalled();
  });

  it("coalesces duplicate submit and routes only after explicit acceptance", async () => {
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    let resolve!: () => void;
    const auth = authValue("anonymous");
    vi.mocked(auth.acceptInvitation).mockImplementation(() => new Promise((done) => { resolve = () => done(authMe("VERIFIED_PENDING_PASSWORD")); }));
    renderWithAuth(<InvitationAcceptPage />, auth);
    const button = await screen.findByRole("button", { name: "설정 코드 수락" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(auth.acceptInvitation).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/complete-invitation"));
  });

  it("keeps the in-memory value for a deliberate retry after 429", async () => {
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    const auth = authValue("anonymous");
    vi.mocked(auth.acceptInvitation)
      .mockRejectedValueOnce(new ApiError(429, "provider raw detail", "RATE_LIMITED"))
      .mockResolvedValueOnce(authMe("VERIFIED_PENDING_PASSWORD"));
    renderWithAuth(<InvitationAcceptPage />, auth);

    fireEvent.click(await screen.findByRole("button", { name: "설정 코드 수락" }));
    expect(await screen.findByText(/요청이 너무 많습니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(auth.acceptInvitation).toHaveBeenCalledTimes(2));
    const acceptMock = vi.mocked(auth.acceptInvitation);
    expect(acceptMock.mock.calls[0][0]).toBe(acceptMock.mock.calls[1][0]);
  });

  it("preserves another active account and offers explicit logout", async () => {
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    const auth = authValue("authenticated");
    vi.mocked(auth.acceptInvitation).mockRejectedValue(new ApiError(409, "raw account", "ACTIVE_SESSION_PRESENT"));
    renderWithAuth(<InvitationAcceptPage />, auth);

    fireEvent.click(await screen.findByRole("button", { name: "설정 코드 수락" }));
    expect(await screen.findByText(/다른 계정으로 이미 로그인/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "현재 계정에서 로그아웃" })).toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it.each(["anonymous", "onboarding", "not-provisioned"] as const)(
    "offers logout for an ACTIVE_SESSION_PRESENT conflict while auth is %s",
    async (status) => {
      window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
      const auth = authValue(status);
      vi.mocked(auth.acceptInvitation).mockRejectedValue(
        new ApiError(409, "raw account", "ACTIVE_SESSION_PRESENT")
      );
      renderWithAuth(<InvitationAcceptPage />, auth);

      fireEvent.click(await screen.findByRole("button", { name: "설정 코드 수락" }));
      expect(await screen.findByRole("button", { name: "현재 계정에서 로그아웃" })).toBeTruthy();
      expect(auth.logout).not.toHaveBeenCalled();
    }
  );

  it("invalidates a bfcache-restored link without replaying it", async () => {
    window.history.replaceState(null, "", "/invite/accept#token_hash=abcdefghijklmnopqrstuvwxyz012345");
    const auth = authValue("anonymous");
    renderWithAuth(<InvitationAcceptPage />, auth);
    expect(await screen.findByRole("button", { name: "설정 코드 수락" })).toBeTruthy();

    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    fireEvent(window, pageShow);

    expect(await screen.findByText(/브라우저 기록에서 복원된/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "설정 코드 수락" })).toBeNull();
    expect(auth.acceptInvitation).not.toHaveBeenCalled();
  });

  it("mounts password inputs only for onboarding and prevents duplicate completion", async () => {
    const loading = authValue("loading");
    const { rerender } = renderWithAuth(<CompleteInvitationPage />, loading);
    expect(screen.getByText("최초 설정 세션을 확인하고 있습니다.")).toBeTruthy();
    expect(screen.queryByLabelText("새 비밀번호")).toBeNull();

    const onboarding = authValue("onboarding");
    let resolve!: () => void;
    vi.mocked(onboarding.completeInvitation).mockImplementation(() => new Promise((done) => { resolve = () => done(authMe("ACTIVE")); }));
    rerender(withAuth(<CompleteInvitationPage />, onboarding));
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "a-strong-password" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "a-strong-password" } });
    const form = screen.getByRole("button", { name: "비밀번호 설정 완료" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onboarding.completeInvitation).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("keeps ordinary login to exactly username and password inputs", () => {
    renderWithAuth(<LoginPage />, authValue("anonymous"));
    const inputs = screen.getAllByRole("textbox").concat(screen.getByLabelText("비밀번호"));
    expect(inputs).toHaveLength(2);
    expect(screen.queryByText(/OTP|MFA|2차 인증|인증 코드/i)).toBeNull();
  });
});

function renderWithAuth(children: ReactNode, value: AuthContextValue) {
  return render(withAuth(children, value));
}

function withAuth(children: ReactNode, value: AuthContextValue) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function authValue(status: AuthContextValue["status"]): AuthContextValue {
  const authenticated = status === "authenticated";
  return {
    user: authenticated
      ? { id: "active-user", username: "active.user", email: null, name: "Active", role: "USER", isActive: true, inviteStatus: "ACTIVE" }
      : null,
    permissions: authenticated ? ["data.read"] : [],
    isLoading: status === "loading",
    isAuthenticated: authenticated,
    status,
    login: vi.fn(),
    acceptInvitation: vi.fn(),
    completeInvitation: vi.fn(),
    logout: vi.fn(),
    can: () => false,
    refreshAuth: vi.fn()
  };
}

function authMe(inviteStatus: "VERIFIED_PENDING_PASSWORD" | "ACTIVE") {
  return {
    user: { id: "invite-user", username: "invite.user", email: null, name: "Invite", role: "USER" as const, isActive: true, inviteStatus },
    permissions: inviteStatus === "ACTIVE" ? ["data.read" as const] : [],
    authorizationVersion: "opaque-v1"
  };
}
