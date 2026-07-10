import { DateRange } from "./date-range";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4100/api";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function uploadCsv(file: File, conflictPolicy = "SKIP") {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", conflictPolicy);
  const response = await fetch(`${API_BASE}/uploads/meta-ad-daily-csv`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function uploadCafe24Csv(file: File, conflictPolicy = "SKIP") {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", conflictPolicy);
  const response = await fetch(`${API_BASE}/sales/cafe24/uploads`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function uploadCoupangSalesXlsx(file: File, options: { conflictPolicy?: string; reportDate?: string } = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", options.conflictPolicy ?? "SKIP");
  if (options.reportDate) {
    formData.append("reportDate", options.reportDate);
  }
  return uploadFormData("/coupang/uploads/sales", formData);
}

export async function uploadCoupangAdsXlsx(file: File, conflictPolicy = "SKIP") {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", conflictPolicy);
  return uploadFormData("/coupang/uploads/ads", formData);
}

export async function uploadCoupangMarginCsv(file: File, options: { conflictPolicy?: string; effectiveFrom?: string } = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", options.conflictPolicy ?? "SKIP");
  if (options.effectiveFrom) {
    formData.append("effectiveFrom", options.effectiveFrom);
  }
  return uploadFormData("/coupang/uploads/margin", formData);
}

export async function uploadCoupangPriceText(file: File, options: { conflictPolicy?: string; effectiveFrom?: string } = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", options.conflictPolicy ?? "SKIP");
  if (options.effectiveFrom) {
    formData.append("effectiveFrom", options.effectiveFrom);
  }
  return uploadFormData("/coupang/uploads/price-text", formData);
}

export async function uploadCoupangPromotionXlsx(file: File, options: { conflictPolicy?: string } = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", options.conflictPolicy ?? "SKIP");
  return uploadFormData("/coupang/uploads/promotion", formData);
}

async function uploadFormData(path: string, formData: FormData) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export function rangeQuery(range: DateRange, extra?: Record<string, string | undefined>) {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

export function withPeriod(path: string, from: string, to: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export const reportDownloadUrl = (id: string) => `${API_BASE}/reports/${id}/download`;

export type DashboardSummary = {
  selectedPeriod: { from: string; to: string; selectedDays: number; dataDays: number };
  totals: {
    spendUsd: number;
    spendKrw: number;
    purchaseCount: number;
    revenueKrw: number;
    marginKrw: number;
    cpaKrw: number | null;
    cpaUsd: number | null;
    roas: number | null;
    ctrLinkPct: number | null;
    cpcLinkUsd: number | null;
    landingPageViews: number;
  };
  averages: { dailySpendKrw: number | null; dailyPurchaseCount: number | null; dailyMarginKrw: number | null };
  comparisons: Record<string, unknown>;
  health: {
    unmatchedCount: number;
    missingCostRuleCount: number;
    missingCpaRuleCount: number;
    missingExchangeRateCount: number;
    uploadErrorCount: number;
  };
  decisions: { counts: Record<string, number>; topRecommendations: DecisionLog[] };
};

export type DecisionLog = {
  id: string;
  scopeType: string;
  decision: string;
  severity: number;
  reason: string;
  recommendedAction?: string | null;
};
