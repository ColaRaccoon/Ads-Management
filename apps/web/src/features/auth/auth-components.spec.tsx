// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { createRef, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DailyCategoryFilter } from "../../app/coupang/daily-report/category-filter";
import { AppFrame } from "../../components/app-frame";
import { AppShell } from "../../components/app-shell";
import { PermissionGate } from "../../components/permission-gate";
import { AuthContext, AuthContextValue } from "./auth-context";
import type { AuthStatus, Permission } from "./auth-types";

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("../../components/date-range-picker", () => ({
  DateRangePicker: () => <div data-testid="date-range-picker" />
}));

beforeAll(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle);
});

afterEach(() => {
  cleanup();
  navigation.pathname = "/dashboard";
  navigation.replace.mockReset();
});

describe("authenticated component integration", () => {
  it("keeps business children and AppShell out of the DOM while auth is loading", () => {
    renderWithAuth(
      <AppFrame><div data-testid="business-data">sensitive business data</div></AppFrame>,
      authValue("loading", [])
    );

    expect(screen.queryByTestId("business-data")).toBeNull();
    expect(screen.queryByText("Meta Uploads")).toBeNull();
    expect(screen.getByText("인증 상태를 확인하고 있습니다.")).toBeTruthy();
  });

  it("redirects an anonymous direct business URL without mounting its children", async () => {
    navigation.pathname = "/settings/products";
    renderWithAuth(
      <AppFrame><div data-testid="product-settings">product editor</div></AppFrame>,
      authValue("anonymous", [])
    );

    expect(screen.queryByTestId("product-settings")).toBeNull();
    expect(screen.queryByText("Meta Product Settings")).toBeNull();
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fproducts");
    });
  });

  it("renders the login route bare and never adds the business AppShell", () => {
    navigation.pathname = "/login";
    renderWithAuth(
      <AppFrame><div data-testid="login-form">login form</div></AppFrame>,
      authValue("anonymous", [])
    );

    expect(screen.getByTestId("login-form")).toBeTruthy();
    expect(screen.queryByText("Meta Uploads")).toBeNull();
  });

  it("routes onboarding to invitation completion without mounting business children", async () => {
    navigation.pathname = "/dashboard";
    renderWithAuth(
      <AppFrame><button type="button">sensitive mutation</button></AppFrame>,
      authValue("onboarding", [])
    );

    expect(screen.queryByRole("button", { name: "sensitive mutation" })).toBeNull();
    expect(screen.queryByText("Meta Uploads")).toBeNull();
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith("/complete-invitation");
    });
  });

  it("renders server-permitted navigation and the display-only role label for an authenticated user", () => {
    renderWithAuth(
      <AppShell><div data-testid="business-page">dashboard data</div></AppShell>,
      authValue("authenticated", ["data.read"], "GUEST")
    );

    expect(screen.getByText("Meta Uploads")).toBeTruthy();
    expect(screen.getByText(/게스트/)).toBeTruthy();
    expect(screen.queryByText("사용자 관리")).toBeNull();
    expect(screen.getByTestId("business-page")).toBeTruthy();
  });

  it("shows user and audit navigation only from the two server permissions", () => {
    const { rerender } = renderWithAuth(
      <AppShell><div>admin page</div></AppShell>,
      authValue("authenticated", ["data.read", "users.manage"], "SUPER_ADMIN")
    );

    expect(screen.getByText("사용자 관리")).toBeTruthy();
    expect(screen.queryByText("보안 감사")).toBeNull();

    rerender(withAuth(
      <AppShell><div>admin page</div></AppShell>,
      authValue("authenticated", ["data.read", "audit.read"], "SUPER_ADMIN")
    ));
    expect(screen.queryByText("사용자 관리")).toBeNull();
    expect(screen.getByText("보안 감사")).toBeTruthy();
  });

  it("PermissionGate mounts mutation controls only from server permissions", () => {
    const { rerender } = renderWithAuth(
      <PermissionGate permission="imports.manage" fallback={<span>read only</span>}>
        <button type="button">upload</button>
      </PermissionGate>,
      authValue("authenticated", ["data.read"], "GUEST")
    );

    expect(screen.queryByRole("button", { name: "upload" })).toBeNull();
    expect(screen.getByText("read only")).toBeTruthy();

    rerender(withAuth(
      <PermissionGate permission="imports.manage">
        <button type="button">upload</button>
      </PermissionGate>,
      authValue("authenticated", ["data.read", "imports.manage"], "ADMIN")
    ));
    expect(screen.getByRole("button", { name: "upload" })).toBeTruthy();
  });

  it("removes both category management entry points for a read-only zero-state", () => {
    renderWithAuth(
      <DailyCategoryFilter
        canManage={false}
        categories={[]}
        selected={new Set()}
        includeUncategorized={false}
        hasQuery={false}
        loading={false}
        error={false}
        manageButtonRef={createRef<HTMLButtonElement>()}
        onSelectedChange={vi.fn()}
        onIncludeUncategorizedChange={vi.fn()}
        onReset={vi.fn()}
        onRetry={vi.fn()}
        onManage={vi.fn()}
      />,
      authValue("authenticated", ["data.read"], "GUEST")
    );

    expect(screen.queryByRole("button", { name: "카테고리 관리" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "카테고리 선택" }));
    expect(screen.queryByRole("button", { name: "첫 카테고리 만들기" })).toBeNull();
    expect(screen.getByText("카테고리 관리 권한이 없어 전체 제품 범위로 조회합니다.")).toBeTruthy();
  });
});

function renderWithAuth(children: ReactNode, value: AuthContextValue) {
  return render(withAuth(children, value));
}

function withAuth(children: ReactNode, value: AuthContextValue) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function authValue(
  status: AuthStatus,
  permissions: Permission[],
  role: "SUPER_ADMIN" | "ADMIN" | "USER" | "GUEST" = "GUEST"
): AuthContextValue {
  const granted = new Set(permissions);
  const authenticated = status === "authenticated";
  return {
    user: authenticated
      ? { id: "user-1", email: "role@example.test", name: "Role User", role, isActive: true, inviteStatus: "ACTIVE" }
      : null,
    permissions,
    isLoading: status === "loading",
    isAuthenticated: authenticated,
    status,
    login: vi.fn(),
    acceptInvitation: vi.fn(),
    completeInvitation: vi.fn(),
    logout: vi.fn(),
    can: (permission) => granted.has(permission),
    refreshAuth: vi.fn(async () => null)
  };
}
