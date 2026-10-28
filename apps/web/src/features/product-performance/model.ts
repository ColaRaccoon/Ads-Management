import { ApiError, apiGet } from "@/lib/api";
import { koreaYesterdayDateInput } from "@/lib/korea-date";
import { storefrontDecimal, storefrontMoney, storefrontTime } from "@/lib/storefront-display";
import { PLATFORMS, PLATFORM_LABELS, type Bucket, type DashboardData, type Diagnostic, type Envelope, type Filters,
  type Metric, type MetricComparison, type Options, type PageResult, type Platform, type ProductRow } from "./types";

export const decimal = storefrontDecimal;
export const money = storefrontMoney;
export const time = storefrontTime;
const DAY = 86400000;
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
export function defaultFilters(): Filters {
  const to = koreaYesterdayDateInput(), from = shiftDate(to, -29);
  return effectiveFilters({ from, to, compareFrom: "", compareTo: "", compareMode: "previous", grain: "day", platforms: [...PLATFORMS], productName: "" });
}
export function effectiveFilters(value: Filters): Filters {
  const valid = validDate(value.from) && validDate(value.to) && value.from <= value.to;
  const previous = valid ? value.compareMode === "week" ? { compareFrom: shiftDate(value.from, -7), compareTo: shiftDate(value.to, -7) }
    : value.compareMode === "previous" ? { compareFrom: shiftDate(value.from, -dayCount(value.from, value.to)), compareTo: shiftDate(value.from, -1) } : {} : {};
  return { ...value, ...previous, platforms: PLATFORMS.filter(p => value.platforms.includes(p)),
    ...(value.scopeKeys === undefined ? {} : { scopeKeys: [...new Set(value.scopeKeys)].sort() }) };
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validateFilters(value: Filters): string | null {
  for (const [from, to] of [[value.from, value.to], [value.compareFrom, value.compareTo]]) {
    if (!validDate(from) || !validDate(to) || from > to) return "시작일과 종료일을 확인해 주세요.";
    if (dayCount(from, to) > 366) return "조회·비교기간은 각각 최대 366일입니다.";
  }
  if (value.scopeKeys && (value.scopeKeys.length > 50 || value.scopeKeys.some(s => !s.trim() || s.length > 256))) return "계정·스토어 범위를 확인해 주세요.";
  if (value.productName.length > 256) return "제품명을 확인해 주세요.";
  return null;
}
export function parseFilters(params: URLSearchParams): Filters {
  const value = defaultFilters();
  for (const key of ["from", "to", "compareFrom", "compareTo", "productName"] as const) if (params.has(key)) value[key] = params.get(key)!;
  const mode = params.get("compareMode") ?? (params.has("compareFrom") || params.has("compareTo") ? "custom" : "previous");
  if (!["previous", "week", "custom"].includes(mode)) throw new Error("URL의 비교기간 방식을 확인해 주세요.");
  value.compareMode = mode as Filters["compareMode"];
  const grain = params.get("grain") ?? "day";
  if (!["day", "week", "month"].includes(grain)) throw new Error("URL의 일·주·월 구분을 확인해 주세요.");
  value.grain = grain as Filters["grain"];
  if (params.has("platforms")) {
    const platforms: unknown = JSON.parse(params.get("platforms")!);
    if (!Array.isArray(platforms) || platforms.some(p => !PLATFORMS.includes(p))) throw new Error("URL의 플랫폼 선택을 확인해 주세요.");
    value.platforms = platforms;
  }
  if (params.has("scopeKeys")) {
    const scopes: unknown = JSON.parse(params.get("scopeKeys")!);
    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== "string")) throw new Error("URL의 계정·스토어 범위를 확인해 주세요.");
    value.scopeKeys = scopes;
  }
  if (params.has("scopeMemory")) {
    const memory: unknown = JSON.parse(params.get("scopeMemory")!);
    if (!memory || typeof memory !== "object" || Array.isArray(memory) || Object.keys(memory).length > 50 ||
      Object.entries(memory).some(([key, platforms]) => !key.trim() || key.length > 256 || !Array.isArray(platforms) || !platforms.length || platforms.length > 5 ||
        platforms.some(p => !PLATFORMS.includes(p)))) throw new Error("URL의 계정 선택 기록을 확인해 주세요.");
    value.scopeMemory = memory as Record<string, Platform[]>;
  }
  return effectiveFilters(value);
}
export function filterParams(value: Filters, forUrl = false): URLSearchParams {
  const f = effectiveFilters(value);
  const params = new URLSearchParams({ from: f.from, to: f.to, compareFrom: f.compareFrom, compareTo: f.compareTo,
    grain: f.grain, platforms: JSON.stringify(f.platforms) });
  if (f.productName) params.set("productName", f.productName);
  if (f.scopeKeys !== undefined) params.set("scopeKeys", JSON.stringify(f.scopeKeys));
  if (forUrl) {
    params.set("compareMode", f.compareMode);
    if (f.scopeMemory && Object.keys(f.scopeMemory).length) params.set("scopeMemory", JSON.stringify(f.scopeMemory));
  }
  return params;
}
/** Retain chosen accounts of temporarily excluded platforms in URL-only state, never in an API request. */
export function changeFilters(current: Filters, raw: Filters, scopes: Options["scopes"]): Filters {
  const next = effectiveFilters(raw);
  if (next.scopeKeys === undefined) return { ...next, scopeMemory: undefined };
  const metadata = new Map<string, Platform[]>();
  for (const [scope, platforms] of Object.entries(current.scopeMemory ?? {})) metadata.set(scope, platforms);
  // Legacy Meta/Cafe24 can share one key. A key remains active if any of its platforms is selected.
  for (const scope of scopes) metadata.set(scope.scopeKey, PLATFORMS.filter(p => p === scope.platform || metadata.get(scope.scopeKey)?.includes(p)));
  const memory = new Map(Object.entries(current.scopeMemory ?? {}));
  const platformChanged = JSON.stringify(current.platforms) !== JSON.stringify(next.platforms);
  if (!platformChanged) for (const [scope, platforms] of memory) if (platforms.some(p => next.platforms.includes(p))) memory.delete(scope);
  for (const scope of platformChanged ? current.scopeKeys ?? [] : next.scopeKeys) {
    const platforms = metadata.get(scope);
    if (platforms) memory.set(scope, platforms);
  }
  return { ...next, scopeKeys: platformChanged ? [...memory].filter(([, platforms]) => platforms.some(p => next.platforms.includes(p))).map(([scope]) => scope).sort() : next.scopeKeys,
    scopeMemory: Object.fromEntries([...memory].sort(([a], [b]) => a.localeCompare(b))) };
}
export const dashboardKey = (identity: string, value: Filters) => ["product-performance", identity, filterParams(value).toString()] as const;
export function responseMatches(data: Envelope, filters: Filters) {
  const f = effectiveFilters(filters), s = data.selection;
  return s.from === f.from && s.to === f.to && s.compareFrom === f.compareFrom && s.compareTo === f.compareTo &&
    s.grain === f.grain && s.productName === (f.productName || null) &&
    JSON.stringify(s.selectedPlatforms) === JSON.stringify(f.platforms) &&
    (f.scopeKeys === undefined || JSON.stringify([...new Set(s.scopeKeys)].sort()) === JSON.stringify(f.scopeKeys));
}
export function assertResponse(data: Envelope, filters: Filters, anchor?: Envelope) {
  if (!responseMatches(data, filters) || anchor && (data.snapshotHash !== anchor.snapshotHash || data.selection.selectionHash !== anchor.selection.selectionHash))
    throw new ApiError(409, "조회 조건 또는 발행 버전이 바뀌었습니다. 다시 조회해 주세요.", "UNIFIED_DASHBOARD_CHANGED");
}
export type Reader = <T>(path: string) => Promise<T>;
export async function loadDashboard(filters: Filters, read: Reader = apiGet, signal?: AbortSignal): Promise<DashboardData> {
  const invalid = validateFilters(filters);
  if (invalid) throw new Error(invalid);
  const query = filterParams(filters).toString();
  const get = async <T extends Envelope>(path: string) => { signal?.throwIfAborted(); const result = await read<T>(path); signal?.throwIfAborted(); return result; };
  for (let attempt = 0; ; attempt++) {
    try {
      const [summary, timeseries, diagnostics] = await Promise.all([
        get<PageResult<ProductRow>>(`/unified-performance/summary?${query}`),
        get<PageResult<Bucket>>(`/unified-performance/timeseries?${query}`),
        get<PageResult<Diagnostic>>(`/unified-performance/diagnostics?${query}`)
      ]);
      for (const response of [summary, timeseries, diagnostics]) assertResponse(response, filters, summary);
      // Daily series can exceed the API's 100-bucket page size. Never truncate a 366-day graph.
      const seen = new Set<string>();
      while (timeseries.nextCursor) {
        if (seen.has(timeseries.nextCursor)) throw new Error("시계열 페이지가 반복되어 조회를 중단했습니다.");
        seen.add(timeseries.nextCursor);
        const next = await get<PageResult<Bucket>>(`/unified-performance/timeseries?${query}&cursor=${encodeURIComponent(timeseries.nextCursor)}`);
        assertResponse(next, filters, summary);
        timeseries.items.push(...next.items); timeseries.nextCursor = next.nextCursor;
      }
      return { summary, timeseries, diagnostics };
    } catch (error) {
      if (attempt === 0 && error instanceof ApiError && ["UNIFIED_CURSOR_CHANGED", "UNIFIED_DASHBOARD_CHANGED"].includes(error.code ?? "")) continue;
      throw error;
    }
  }
}

// Decimal strings remain exact in every card/table/tooltip. BigInt arithmetic is only for display deltas.
function scaled(value: string, scale: number): bigint | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null;
  return BigInt(`${whole}${fraction.slice(0, scale).padEnd(scale, "0")}`) * (value.startsWith("-") ? -1n : 1n);
}
function unscale(value: bigint, scale: number) {
  const sign = value < 0 ? "-" : "", digits = (value < 0 ? -value : value).toString().padStart(scale + 1, "0");
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
export function difference(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return null;
  const aa = scaled(a, 10), bb = scaled(b, 10);
  return aa === null || bb === null ? null : unscale(aa - bb, 10);
}
export function ratioPercent(a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null) return null;
  const aa = scaled(a, 10), bb = scaled(b, 10);
  if (aa === null || bb === null || bb <= 0n) return null;
  const sign = aa < 0n ? -1n : 1n, numerator = aa * sign * 1000000000000n;
  const rounded = numerator / bb + (numerator % bb * 2n >= bb ? 1n : 0n);
  return unscale(rounded * sign, 10);
}
function rounded(value: string | null | undefined) {
  if (value == null) return "—";
  const exact = scaled(value, 10);
  if (exact === null) return "—";
  const sign = exact < 0n ? -1n : 1n;
  const cents = ((exact * sign) + 50000000n) / 100000000n * sign;
  return decimal(unscale(cents, 2));
}
export const percent = (value: string | null | undefined) => value == null ? "—" : `${rounded(value)}%`;
export const percentagePoints = (value: string | null | undefined) => value == null ? "—" : `${rounded(value)} %p`;
export function metricLabel(metric: Metric, data: Envelope) {
  const partial = data.selectedPlatforms.length !== PLATFORMS.length;
  return ({ revenue: partial ? "선택 플랫폼 매출" : "운영매출", adSpend: partial ? "선택 광고비" : "전체 광고비",
    profitBeforeAds: "광고 전 이익", estimatedProfit: data.metricAvailability.state === "SALE_ONLY" ? "선택 범위 광고 전 이익" : partial ? "선택 범위 추정이익" : "추정 순이익",
    mer: partial ? "선택 범위 MER" : "MER" })[metric];
}
export function comparisonReason(value: MetricComparison) {
  if (value.reason === "MISSING_INPUT") return "비교 입력 미확인";
  const sign = (s: string | null) => s == null ? null : /^-/.test(s) && /[1-9]/.test(s) ? -1 : /[1-9]/.test(s) ? 1 : 0;
  if (value.reason === "ZERO_BASE") return sign(value.current) === 1 ? "신규 집행·전기 0" : "전기 0 · 증감률 해당 없음";
  if (value.reason === "NON_POSITIVE_PROFIT_BASE") {
    const now = sign(value.current), before = sign(value.previous);
    return now === 1 && before !== null && before <= 0 ? "흑자 전환" : now === -1 && before !== null && before >= 0 ? "적자 전환" : "비양수 이익 기준 · 증감액 확인";
  }
  return "";
}
const LABELS: Record<string, string> = { ...PLATFORM_LABELS, NAVER_DA: "네이버 DA", COUPANG_ADS: "쿠팡 광고", NAVER_SMARTSTORE: "네이버 스마트스토어",
  SALE: "상품매출", AD_SPEND: "광고비", DIRECT_COST: "직접비·원가", COMMON_EXPENSE: "공통비", SHIPPING_INCOME: "배송수입",
  COMPLETE: "수집 완료", PARTIAL: "부분 수집", NOT_COLLECTED: "미수집", STALE: "이전 성공 자료", INCLUDED: "포함", EXCLUDED_BY_USER: "사용자 제외", NOT_APPLICABLE: "해당 없음",
  ESTIMATED: "추정 데이터", PARTIAL_TOTAL: "확인된 부분 금액", INCOMPLETE_COVERAGE: "미완료 수집 포함", UNALLOCATED_BALANCE: "미배분 잔액 있음",
  UNCLASSIFIED_SALES: "미분류 판매 있음", ZERO_AD_SPEND_BASE: "광고비 0 · MER 해당 없음", CONFIGURATION_CHANGED_REBUILD_RECOMMENDED: "현재 설정과 발행 버전이 다릅니다. 재집계가 필요합니다.",
  LATEST_REBUILD_FAILED: "최근 재집계 실패 · 이전 발행 자료 확인", MISSING_INPUT: "입력 미확인", ZERO_BASE: "전기 0", MIXED: "여러 발행 버전" };
export const label = (key: string | null | undefined) => key ? LABELS[key] ?? key : "미확인";
export function dashboardError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "이 조회의 권한 또는 허용된 계정·스토어 범위를 확인해 주세요.";
    if (error.code === "UNIFIED_PERFORMANCE_DISABLED") return "제품 통합 성과 기능이 아직 활성화되지 않았습니다.";
    if (error.code === "UNIFIED_PRODUCT_NOT_FOUND") return "등록된 고정 제품명을 선택해 주세요.";
    if (error.status === 409) return "발행 버전 또는 조회 조건이 바뀌었습니다. 다시 조회해 주세요.";
    if (["UNIFIED_REPORT_TOO_LARGE", "UNIFIED_SCOPE_LIMIT"].includes(error.code ?? "")) return "조회할 자료가 많습니다. 기간 또는 계정·스토어 범위를 줄여 주세요.";
    if (error.code === "UNIFIED_REPORT_REBUILD_REQUIRED") return "새 계산 기준으로 재집계한 뒤 조회해 주세요.";
  }
  return "성과 데이터를 읽지 못했습니다. 조회 조건을 확인하고 다시 조회해 주세요.";
}
