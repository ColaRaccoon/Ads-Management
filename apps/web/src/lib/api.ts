import { DateRange } from "./date-range";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend-api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  await assertApiResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  await assertApiResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  await assertApiResponse(response);
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  await assertApiResponse(response);
  return response.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE"
  });
  await assertApiResponse(response);
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
  await assertApiResponse(response);
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
  await assertApiResponse(response);
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
  await assertApiResponse(response);
  return response.json();
}

async function assertApiResponse(response: Response) {
  if (response.ok) return;
  const fallback = `요청을 처리하지 못했습니다. (HTTP ${response.status})`;
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    throw new ApiError(response.status, fallback);
  }
  const parsed = parseApiErrorPayload(raw);
  throw new ApiError(response.status, parsed.message ?? fallback, parsed.code);
}

export function parseApiErrorPayload(raw: string): { code: string | null; message: string | null } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { code: null, message: null };
    }
    const payload = value as Record<string, unknown>;
    const details = payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? payload.details as Record<string, unknown>
      : null;
    const code = safeApiCode(details?.code) ?? safeApiCode(payload.code);
    return { code, message: safeApiMessage(payload.message) };
  } catch {
    return { code: null, message: null };
  }
}

function safeApiCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value)
    ? value
    : null;
}

function safeApiMessage(value: unknown): string | null {
  const source = typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.join(" ")
      : "";
  const normalized = source.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 && normalized.length <= 500 ? normalized : null;
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
