import { DateRange } from "./date-range";
import { authCoordinator } from "../features/auth/auth-coordination";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend-api";
const AUTH_MUTATION_PATHS = new Set(["/auth/login", "/auth/refresh", "/auth/logout"]);
const SESSION_ENDING_CODES = new Set([
  "AUTHENTICATION_REQUIRED",
  "SESSION_INVALID",
  "SESSION_REVOKED",
  "ACCOUNT_INACTIVE"
]);

export type AuthLifecycleEvent =
  | { type: "session-invalid"; code: string }
  | { type: "account-not-provisioned" }
  | { type: "onboarding-required" }
  | { type: "permission-denied" }
  | { type: "refresh-failed"; code: string | null };

const authLifecycleListeners = new Set<(event: AuthLifecycleEvent) => void>();
let refreshPromise: Promise<void> | null = null;
let sessionEpoch = 0;

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

export function subscribeAuthLifecycle(listener: (event: AuthLifecycleEvent) => void) {
  authLifecycleListeners.add(listener);
  return () => {
    authLifecycleListeners.delete(listener);
  };
}

type ApiRequestOptions = Omit<RequestInit, "body" | "method"> & {
  method?: string;
  body?: unknown;
};

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
  retryAfterRefresh = false
): Promise<T> {
  const requestEpoch = sessionEpoch;
  const response = await request(path, options);
  assertSessionEpoch(requestEpoch);
  if (response.ok) {
    const result = await parseApiSuccess<T>(response);
    assertSessionEpoch(requestEpoch);
    return result;
  }

  const error = await apiErrorFromResponse(response);
  assertSessionEpoch(requestEpoch);
  if (
    error.code === "ACCESS_TOKEN_EXPIRED" &&
    !retryAfterRefresh &&
    !AUTH_MUTATION_PATHS.has(normalizePath(path))
  ) {
    try {
      await refreshAccessToken();
    } catch {
      throw error;
    }
    return apiRequest<T>(path, options, true);
  }
  if (error.code === "ACCESS_TOKEN_EXPIRED" && retryAfterRefresh) {
    emitAuthLifecycle({ type: "refresh-failed", code: error.code });
  } else {
    handleAuthLifecycle(error);
  }
  throw error;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { cache: "no-store" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "POST", body });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PATCH", body });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PUT", body });
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "DELETE" });
}

export async function uploadCsv(file: File, conflictPolicy = "SKIP"): Promise<any> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", conflictPolicy);
  return apiRequest("/uploads/meta-ad-daily-csv", { method: "POST", body: formData });
}

export async function uploadCafe24Csv(file: File, conflictPolicy = "SKIP"): Promise<any> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conflictPolicy", conflictPolicy);
  return apiRequest("/sales/cafe24/uploads", { method: "POST", body: formData });
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

async function uploadFormData(path: string, formData: FormData): Promise<any> {
  return apiRequest(path, { method: "POST", body: formData });
}

async function request(path: string, options: ApiRequestOptions) {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  const body = requestBody(options.body, headers);
  if (isMutation(method)) {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  }
  return fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,
    body,
    credentials: "include"
  });
}

function requestBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  headers.set("Content-Type", "application/json");
  return JSON.stringify(body);
}

async function parseApiSuccess<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const raw = await response.text();
  if (raw.length === 0) return undefined as T;
  return JSON.parse(raw) as T;
}

async function apiErrorFromResponse(response: Response) {
  const fallback = `요청을 처리하지 못했습니다. (HTTP ${response.status})`;
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return new ApiError(response.status, fallback);
  }
  const parsed = parseApiErrorPayload(raw);
  return new ApiError(response.status, parsed.message ?? fallback, parsed.code);
}

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = authCoordinator.runRefresh(async () => {
    const response = await request("/auth/refresh", { method: "POST" });
    if (response.ok) {
      await parseApiSuccess(response);
      return;
    }
    const error = await apiErrorFromResponse(response);
    if (error.code === "REFRESH_RACE_RETRY") {
      await authCoordinator.waitForPeerRefresh(undefined, 1_500);
      return;
    }
    handleAuthLifecycle(error);
    emitAuthLifecycle({ type: "refresh-failed", code: error.code });
    throw error;
  }).then(() => undefined).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

function handleAuthLifecycle(error: ApiError) {
  if (error.code && SESSION_ENDING_CODES.has(error.code)) {
    emitAuthLifecycle({ type: "session-invalid", code: error.code });
  } else if (error.code === "ACCOUNT_NOT_PROVISIONED") {
    emitAuthLifecycle({ type: "account-not-provisioned" });
  } else if (error.code === "ACCOUNT_ONBOARDING_REQUIRED") {
    emitAuthLifecycle({ type: "onboarding-required" });
  } else if (error.code === "PERMISSION_DENIED") {
    emitAuthLifecycle({ type: "permission-denied" });
  }
}

function emitAuthLifecycle(event: AuthLifecycleEvent) {
  for (const listener of authLifecycleListeners) listener(event);
}

function isMutation(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function normalizePath(path: string) {
  return path.split("?", 1)[0];
}

export function csrfTokenFromCookieString(cookieString: string) {
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (
      name !== "meta_csrf" &&
      name !== "__Host-meta_csrf" &&
      !/^__Host-[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-meta_csrf$/.test(name)
    ) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function invalidateApiSession() {
  sessionEpoch += 1;
}

function assertSessionEpoch(requestEpoch: number) {
  if (requestEpoch !== sessionEpoch) {
    throw new ApiError(409, "인증 상태가 변경되어 응답을 폐기했습니다.", "AUTH_CONTEXT_CHANGED");
  }
}

function readCsrfToken() {
  return typeof document === "undefined" ? null : csrfTokenFromCookieString(document.cookie);
}

export function resetApiClientForTests() {
  refreshPromise = null;
  sessionEpoch = 0;
  authLifecycleListeners.clear();
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
