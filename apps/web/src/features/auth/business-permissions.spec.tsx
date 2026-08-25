// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React, { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChangeLogsPage from "../../app/change-logs/page";
import DashboardPage from "../../app/dashboard/page";
import ProductSettingsPage from "../../app/settings/products/page";
import UploadsPage from "../../app/uploads/page";
import { AuthContext, AuthContextValue } from "./auth-context";
import type { Permission } from "./auth-types";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  uploadCafe24: vi.fn(),
  uploadMeta: vi.fn()
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  apiGet: apiMocks.get,
  apiPost: apiMocks.post,
  apiPatch: apiMocks.patch,
  apiDelete: apiMocks.remove,
  uploadCafe24Csv: apiMocks.uploadCafe24,
  uploadCsv: apiMocks.uploadMeta
}));

vi.mock("../../components/Charts", () => ({
  ProductBarChart: () => <div data-testid="product-chart" />,
  StageBarChart: () => <div data-testid="stage-chart" />,
  TrendChart: () => <div data-testid="trend-chart" />
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("server-permission business page integration", () => {
  it("keeps a GUEST change-log timeline readable while removing the create form and handler", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/change-logs/products/product-1")) {
        return {
          product: { id: "product-1", name: "읽기 제품" },
          date: "2026-08-23",
          adsDate: "2026-08-23",
          isPreviousAdsDate: false,
          spendUsd: 12,
          activeAdCount: 1,
          inactiveAdCount: 0,
          ads: { active: [], inactive: [] },
          logs: [{ id: "log-1", actionDate: "2026-08-23", text: "기존 운영 기록", createdAt: "2026-08-23T00:00:00Z" }]
        };
      }
      if (path.startsWith("/change-logs/products")) {
        return [{ id: "product-1", productName: "읽기 제품", spendUsd: 12 }];
      }
      return [];
    });

    renderBusiness(<ChangeLogsPage />, ["data.read"], "GUEST");

    expect(await screen.findByText("기존 운영 기록")).toBeTruthy();
    expect(screen.queryByPlaceholderText("기록")).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.getByText("읽기 전용 계정입니다. 기존 기록은 계속 확인할 수 있습니다.")).toBeTruthy();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("keeps USER dashboard data and filters while removing the decision mutation", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/dashboard/summary")) return dashboardSummary();
      return [];
    });

    renderBusiness(<DashboardPage />, userPermissions(), "USER");

    expect(await screen.findByText("자동 판정")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "판정 실행" })).toBeNull();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("keeps USER upload history but removes forms, delete handlers, and action columns", async () => {
    apiMocks.get.mockImplementation(async (path: string) => path === "/uploads"
      ? [{
          id: "meta-1", originalFilename: "existing-meta.csv", status: "DONE", level: "AD",
          rowCount: 3, validRowCount: 3, warningCount: 0, errorCount: 0, fileHashSha256: "1234567890abcdef"
        }]
      : [{
          id: "cafe-1", originalFilename: "existing-cafe.csv", status: "DONE", rowCount: 2,
          validRowCount: 2, warningCount: 0, errorCount: 0, orderStart: "2026-08-01", orderEnd: "2026-08-02"
        }]);

    const { container } = renderBusiness(<UploadsPage />, userPermissions(), "USER");

    expect(await screen.findByText("existing-meta.csv")).toBeTruthy();
    expect(screen.getByText("existing-cafe.csv")).toBeTruthy();
    expect(screen.queryByLabelText(/파일/)).toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(screen.queryByTitle("삭제")).toBeNull();
    expect(screen.queryByTitle("Cafe24 업로드 삭제")).toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(17);
    expect(apiMocks.remove).not.toHaveBeenCalled();
  });

  it("keeps USER product rows and history surfaces while removing every product mutation control", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/products") return [{ id: "product-1", code: "P1", name: "Readonly Product", displayName: "Readonly Product" }];
      if (path === "/sales/cafe24/coupon-products") return [];
      return [];
    });

    renderBusiness(<ProductSettingsPage />, userPermissions(), "USER");

    expect(await screen.findByText("Readonly Product")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /제품 추가/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /저장/ })).toBeNull();
    expect(screen.queryByTitle("제품 규칙 편집")).toBeNull();
    expect(screen.queryByTitle("제품 삭제")).toBeNull();
    expect(screen.queryByText("관리")).toBeNull();
    expect(apiMocks.post).not.toHaveBeenCalled();
    expect(apiMocks.patch).not.toHaveBeenCalled();
    expect(apiMocks.remove).not.toHaveBeenCalled();
  });
});

function renderBusiness(children: ReactNode, permissions: Permission[], role: "GUEST" | "USER") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const granted = new Set(permissions);
  const auth: AuthContextValue = {
    user: { id: "role-user", email: "role@example.test", name: "Role User", role, isActive: true, inviteStatus: "ACTIVE" },
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
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </QueryClientProvider>
  );
}

function userPermissions(): Permission[] {
  return ["data.read", "reports.generate", "change_logs.create"];
}

function dashboardSummary() {
  return {
    selectedPeriod: { from: "2026-08-01", to: "2026-08-23", selectedDays: 23, dataDays: 1 },
    totals: {
      spendUsd: 1, spendKrw: 1300, purchaseCount: 1, revenueKrw: 2000, marginKrw: 700,
      cpaKrw: 1300, cpaUsd: 1, roas: 2, ctrLinkPct: 1, cpcLinkUsd: 1, landingPageViews: 1
    },
    averages: { dailySpendKrw: 1300, dailyPurchaseCount: 1, dailyMarginKrw: 700 },
    comparisons: {},
    health: {
      unmatchedCount: 0, missingCostRuleCount: 0, missingCpaRuleCount: 0,
      missingExchangeRateCount: 0, uploadErrorCount: 0
    },
    decisions: { counts: {}, topRecommendations: [] }
  };
}
