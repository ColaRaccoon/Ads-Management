import { PLATFORM_LABELS, type Aggregate, type DashboardData, type DisplayAmount, type Filters, type Platform, type SelectionOptions } from "./types";
import { NATIVE_OVERLAP_HELP, type NativeSourcePublication } from "./native-result-metadata";

export const DAILY_PRODUCT_GROUPS = [
  { key: "STOREFRONT", label: "자사몰" }, { key: "COUPANG", label: "쿠팡" },
  { key: "NAVER", label: "네이버" }, { key: "GOOGLE", label: "구글" }, { key: "TOTAL", label: "전체" }
] as const;
export const DAILY_PRODUCT_METRICS = [
  { key: "adSpend", label: "광고비" }, { key: "revenue", label: "매출" }, { key: "netProfit", label: "순이익" }
] as const;
export type DailyProductGroup = typeof DAILY_PRODUCT_GROUPS[number]["key"];
export type DailyProductMetric = typeof DAILY_PRODUCT_METRICS[number]["key"];
export type PublishedAmount = {
  value: string | null;
  state: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE" | "EXCLUDED";
  isEstimate: boolean;
  reasonCodes: string[];
};
export type ComparedMetric = {
  current: PublishedAmount; previous: PublishedAmount;
  change: string | null; changePct: string | null; comparisonReason: string | null;
};
export type DailyProductRow = {
  productKey: string; productName: string; active: boolean; historical: boolean;
  exportPlatforms?: Exclude<DailyProductGroup, "TOTAL">[];
  groups: Record<DailyProductGroup, Record<DailyProductMetric, ComparedMetric>>;
};
export type DailyProductsAggregate = Pick<Aggregate, "knownTotals" | "completeTotals" | "byMarketplace" | "byMedium" | "isEstimate"> &
  Partial<Pick<Aggregate, "scopeBalances">> & {
    notApplicable?: { revenue: Platform[]; adSpend: Platform[] };
    comparisonBasis?: { NAVER?: string };
  };
export type DailyProductsSourceRow = Pick<DailyProductRow, "productKey" | "productName" | "active" | "historical" | "exportPlatforms"> & {
  current: DailyProductsAggregate; previous: DailyProductsAggregate;
};
export type DailyProductsResponse = Pick<DashboardData, "summary" | "timeseries"> & {
  exportActivityVersion?: number;
  reportDate: string; previousDate: string; totalProducts: number; nextCursor: null;
  products: DailyProductsSourceRow[];
  allProducts: { current: DailyProductsAggregate; previous: DailyProductsAggregate };
};
export type DailyReconciliation = { key: string; label: string; current: string | null; previous: string | null };
export type DailyProductsReport = {
  resultBasis?: "NATIVE_FINAL";
  sourcePublicationTimes?: NativeSourcePublication[];
  exportActivityVersion?: number;
  date: string; previousDate: string; snapshotHash: string; scopeLabel: string;
  rows: DailyProductRow[]; totals: DailyProductRow; warnings: string[]; provisional: boolean;
  reconciliation: DailyReconciliation[];
  exportSelection?: { platform: Exclude<DailyProductGroup, "TOTAL"> | "ALL"; label: string; totalProducts: number; basis: string };
};

const SCALE = 10n ** 10n;
/** Presentation arithmetic only. Published revenue, profit and spend are never reconstructed. */
function scaled(value: string | null | undefined): bigint | null {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (fraction.length > 10 && /[1-9]/.test(fraction.slice(10))) return null;
  return BigInt(whole + fraction.slice(0, 10).padEnd(10, "0")) * (value.startsWith("-") ? -1n : 1n);
}
function exact(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString().padStart(11, "0");
  return `${value < 0n ? "-" : ""}${digits.slice(0, -10)}.${digits.slice(-10)}`;
}
function signed(value: bigint): -1 | 0 | 1 { return value < 0n ? -1 : value > 0n ? 1 : 0; }
function rounded(value: string, places: number): string {
  const amount = scaled(value);
  if (amount === null) return "—";
  const divisor = 10n ** BigInt(10 - places), magnitude = amount < 0n ? -amount : amount;
  const result = (magnitude + divisor / 2n) / divisor;
  const digits = result.toString().padStart(places + 1, "0");
  return `${amount < 0n && result !== 0n ? "−" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
export function dailyProductMoney(value: string | null): string {
  if (value === null) return "—";
  return rounded(value, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function dailyProductStateLabel(amount: PublishedAmount): string {
  return ({ COMPLETE: "확인", PARTIAL: "부분 금액", UNAVAILABLE: "자료 없음", NOT_APPLICABLE: "해당 없음", EXCLUDED: "제외" })[amount.state];
}
export function dailyProductChange(metric: ComparedMetric): string {
  if (metric.current.state === "EXCLUDED") return "제외";
  if (metric.current.state === "NOT_APPLICABLE") return "해당 없음";
  if (metric.comparisonReason === "STOREFRONT_SCOPE_CHANGED" || metric.comparisonReason === "NAVER_BASIS_CHANGED") return "기준 변경";
  if (metric.current.value === null) return "자료 없음";
  if (metric.previous.value === null) return "전일 없음";
  if (metric.comparisonReason === "ZERO_BASE") return "전일 0";
  if (metric.comparisonReason === "NEGATIVE_BASE") return (scaled(metric.current.value) ?? 0n) > 0n ? "흑자 전환" : "전일 음수";
  if (metric.changePct === null) return "비교 불가";
  const display = rounded(metric.changePct, 1);
  return `${!display.startsWith("−") && display !== "0.0" ? "+" : ""}${display}%`;
}
export function dailyProductTone(metric: ComparedMetric): "up" | "down" | "neutral" {
  const change = scaled(metric.change);
  return change === null || change === 0n ? "neutral" : change > 0n ? "up" : "down";
}
const emptyAmount = (state: PublishedAmount["state"] = "UNAVAILABLE", reason?: string): PublishedAmount =>
  ({ value: null, state, isEstimate: false, reasonCodes: reason ? [reason] : [] });
function amount(display: DisplayAmount | undefined, fallback: string | null | undefined, isEstimate: boolean, reason?: string): PublishedAmount {
  const value = display?.state === "UNAVAILABLE" ? null : display ? display.value : fallback ?? null;
  const valid = value !== null && scaled(value) !== null;
  return { value: valid ? value : null, state: valid ? display?.state ?? "COMPLETE" : "UNAVAILABLE", isEstimate,
    reasonCodes: [...new Set([...(display?.missingSources ?? []).map(source => `MISSING_${source}`), ...(reason ? [reason] : []), ...(value !== null && !valid ? ["INVALID_DECIMAL"] : [])])] };
}
function totalAmount(row: DailyProductsAggregate, key: DailyProductMetric): PublishedAmount {
  const metric = key === "netProfit" ? "estimatedProfit" : key;
  const complete = row.completeTotals[metric], known = row.knownTotals[metric];
  return amount({ value: complete ?? known, state: complete !== null ? "COMPLETE" : known !== null ? "PARTIAL" : "UNAVAILABLE", availableSources: [], missingSources: [] }, null, row.isEstimate);
}
type StorefrontMode = "SPLIT" | "LEGACY" | "MIXED" | "EMPTY";
function storefrontMode(row: DailyProductsAggregate): StorefrontMode {
  const split = row.byMarketplace.some(market => market.marketplace === "CAFE24_META" || market.marketplace === "CAFE24_YOUTUBE");
  const legacy = row.byMarketplace.some(market => market.marketplace === "CAFE24");
  return split ? legacy ? "MIXED" : "SPLIT" : legacy ? "LEGACY" : "EMPTY";
}
function selectedAmount(row: DailyProductsAggregate, group: DailyProductGroup, key: DailyProductMetric, platforms: readonly Platform[]): PublishedAmount {
  const selected = (platform: Platform) => platforms.includes(platform);
  const notApplicable = (sources: readonly Platform[]) => {
    const included = sources.filter(selected), excludedByPolicy = row.notApplicable?.[key === "adSpend" ? "adSpend" : "revenue"] ?? [];
    return included.length > 0 && included.every(source => excludedByPolicy.includes(source));
  };
  if (group === "TOTAL") {
    const sources: Platform[] = key === "adSpend" ? ["META", "GOOGLE", "COUPANG", "NAVER"] : ["CAFE24", "COUPANG", "NAVER"];
    return !sources.some(selected) ? emptyAmount("EXCLUDED") : notApplicable(sources) ? emptyAmount("NOT_APPLICABLE") : totalAmount(row, key);
  }
  const mode = storefrontMode(row), storefront = group === "STOREFRONT";
  const salePlatform: Platform = storefront || group === "GOOGLE" ? "CAFE24" : group;
  const adPlatform: Platform = storefront ? "META" : group;
  const relevantAds: Platform[] = storefront && mode === "LEGACY" ? ["META", "GOOGLE"] : [adPlatform];
  if (key === "adSpend" ? !relevantAds.some(selected) : !selected(salePlatform)) return emptyAmount("EXCLUDED");
  if (notApplicable(key === "adSpend" ? relevantAds : [salePlatform])) return emptyAmount("NOT_APPLICABLE");
  const marketplace = group === "COUPANG" ? "COUPANG" : group === "NAVER" ? "NAVER_SMARTSTORE" :
    group === "GOOGLE" ? "CAFE24_YOUTUBE" : mode === "LEGACY" ? "CAFE24" : "CAFE24_META";
  const market = row.byMarketplace.find(item => item.marketplace === marketplace);
  if (storefront && mode === "MIXED") return emptyAmount("UNAVAILABLE", "MIXED_STOREFRONT_REVISIONS");
  if (key === "adSpend") {
    // Published marketplace spend preserves its own attribution. Media are a safe fallback
    // when a sales platform is excluded; no sales-weighted allocation is introduced.
    if (market?.display?.adSpend) return amount(market.display.adSpend, null, row.isEstimate, market.profitUnavailableReason ?? undefined);
    if (market?.adSpend !== undefined && market.adSpend !== null) return amount(undefined, market.adSpend, row.isEstimate);
    const medium = storefront ? "META" : group === "GOOGLE" ? "GOOGLE" : group === "COUPANG" ? "COUPANG_ADS" : "NAVER_DA";
    const media = row.byMedium.find(item => item.medium === medium);
    return amount(media?.displayAdSpend, media?.completeAdSpend, row.isEstimate);
  }
  const metric = key === "netProfit" ? "estimatedProfit" : "revenue";
  return amount(market?.display?.[metric], key === "revenue" ? market?.completeRevenue : market?.estimatedProfit,
    row.isEstimate, !market && (storefront || group === "GOOGLE") ? "CHANNEL_RESULT_UNAVAILABLE" : market?.profitUnavailableReason ?? undefined);
}
export function compareDailyProductAmounts(current: PublishedAmount, previous: PublishedAmount, changedScope: boolean | "NAVER_BASIS_CHANGED" = false): ComparedMetric {
  const a = scaled(current.value), b = scaled(previous.value);
  const comparisonReason = changedScope ? typeof changedScope === "string" ? changedScope : "STOREFRONT_SCOPE_CHANGED" : a === null ? "CURRENT_UNAVAILABLE" : b === null ? "PREVIOUS_UNAVAILABLE" :
    b === 0n ? "ZERO_BASE" : b < 0n ? "NEGATIVE_BASE" : a < 0n ? "LOSS_TRANSITION" : null;
  const delta = a === null || b === null || changedScope ? null : a - b;
  let pct: string | null = null;
  if (delta !== null && b !== null && b > 0n) {
    const numerator = (delta < 0n ? -delta : delta) * 100n * SCALE;
    pct = exact((numerator / b + (numerator % b * 2n >= b ? 1n : 0n)) * BigInt(signed(delta)));
  }
  return { current, previous, change: delta === null ? null : exact(delta), changePct: pct, comparisonReason };
}
function naverBasisChanged(current: DailyProductsAggregate, previous: DailyProductsAggregate) {
  const now = current.comparisonBasis?.NAVER, before = previous.comparisonBasis?.NAVER;
  return Boolean(now && before && now !== before);
}
function buildRow(row: DailyProductsSourceRow, platforms: readonly Platform[]): DailyProductRow {
  const currentMode = storefrontMode(row.current), previousMode = storefrontMode(row.previous);
  const changedScope = currentMode !== previousMode && currentMode !== "EMPTY" && previousMode !== "EMPTY";
  const naverChanged = platforms.includes("NAVER") && naverBasisChanged(row.current, row.previous);
  const groups = Object.fromEntries(DAILY_PRODUCT_GROUPS.map(group => [group.key,
    Object.fromEntries(DAILY_PRODUCT_METRICS.map(metric => [metric.key, compareDailyProductAmounts(
      selectedAmount(row.current, group.key, metric.key, platforms), selectedAmount(row.previous, group.key, metric.key, platforms),
      naverChanged && (group.key === "NAVER" || group.key === "TOTAL") ? "NAVER_BASIS_CHANGED" :
        (group.key === "STOREFRONT" || group.key === "GOOGLE" && metric.key !== "adSpend") && changedScope)]))
  ])) as DailyProductRow["groups"];
  return { productKey: row.productKey, productName: row.productName, active: row.active, historical: row.historical,
    exportPlatforms: row.exportPlatforms?.slice(), groups };
}

export function dailyProductsScopeLabel(data: DailyProductsResponse, filters: Filters, options?: SelectionOptions): string {
  const platforms = filters.platforms.map(platform => PLATFORM_LABELS[platform]).join(" · ");
  const scopeKeys = [...new Set(data.summary.selection.scopeKeys)];
  const labelByKey = new Map(options?.scopes.map(scope => [scope.scopeKey, scope.label.trim()]) ?? []);
  const labels = scopeKeys.map(key => labelByKey.get(key)).filter((label): label is string => Boolean(label));
  const unresolved = scopeKeys.length - labels.length;
  const detail = options ? [...labels, ...(unresolved ? [`이름 미확인 계정 ${unresolved}개`] : [])].join(" · ") : "";
  return `전체 제품 · ${platforms || "선택 플랫폼 없음"} · ${filters.scopeKeys === undefined ? "접근 가능한 전체 계정·스토어" : "선택 계정·스토어"} ${scopeKeys.length}개${detail ? ` (${detail})` : ""}`;
}

export function buildDailyProductsReport(data: DailyProductsResponse, date: string, filters: Filters, options?: SelectionOptions): DailyProductsReport {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) throw new Error("보고일을 확인해 주세요.");
  const previousDate = new Date(parsed - 86400000).toISOString().slice(0, 10);
  if (data.reportDate !== date || data.previousDate !== previousDate || data.nextCursor !== null || data.totalProducts !== data.products.length ||
    new Set(data.products.map(row => row.productKey)).size !== data.products.length) throw new Error("전체 제품 자료가 완전하지 않습니다. 다시 조회해 주세요.");
  const rows = data.products.map(row => buildRow(row, filters.platforms)).sort((a, b) => a.productName.localeCompare(b.productName, "ko-KR") || a.productKey.localeCompare(b.productKey));
  const totals = buildRow({ productKey: "__total__", productName: "전체 합계", active: true, historical: false, ...data.allProducts }, filters.platforms);
  const scopeLabel = dailyProductsScopeLabel(data, filters, options);
  const aggregateModes = [storefrontMode(data.allProducts.current), storefrontMode(data.allProducts.previous)];
  const warnings: string[] = [];
  if (filters.platforms.includes("NAVER") && naverBasisChanged(data.allProducts.current, data.allProducts.previous))
    warnings.push("전일과 당일의 네이버 집계 기준 또는 포함 원천이 달라 네이버·전체 증감 비교를 제외했습니다. 금액은 각 날짜의 저장된 결과입니다.");
  if (aggregateModes.includes("LEGACY")) warnings.push("이전 집계의 자사몰은 Meta·Google 판매/광고를 포함할 수 있습니다. 구글 매출·순이익은 채널별 저장값이 있을 때만 표시하며 그룹을 더해 전체를 계산하지 않습니다.");
  if (aggregateModes.includes("MIXED")) warnings.push("자사몰의 이전 통합 집계와 채널별 집계가 섞여 자사몰 그룹 금액을 확정할 수 없습니다. 전체 열은 저장된 통합 결과를 표시합니다.");
  if (aggregateModes[0] !== aggregateModes[1] && !aggregateModes.includes("EMPTY")) warnings.push("전일과 당일의 자사몰 집계 범위가 달라 해당 증감 비교를 제외했습니다.");
  if (data.summary.resultBasis !== "NATIVE_FINAL" && filters.platforms.includes("CAFE24") && (!filters.platforms.includes("META") || !filters.platforms.includes("GOOGLE"))) warnings.push("광고 플랫폼을 제외해도 Cafe24 판매처의 해당 매출은 유지됩니다. 광고비 제외 범위의 이익은 해당 광고비를 차감하지 않은 값입니다.");
  if (data.summary.resultBasis === "NATIVE_FINAL" && [...data.summary.issues, ...data.summary.warnings].some(issue =>
    issue === "STOREFRONT_GOOGLE_SALES_MAY_OVERLAP" || issue === "SOURCE_OVERLAP")) warnings.push(NATIVE_OVERLAP_HELP);
  if (data.summary.warnings.includes("CONFIGURATION_CHANGED_REBUILD_RECOMMENDED")) warnings.push("현재 설정과 발행된 집계 기준이 다릅니다. 저장된 발행 금액을 표시합니다.");
  if (data.summary.warnings.includes("LATEST_REBUILD_FAILED") || data.summary.asOfBySource.some(source => source.stale)) warnings.push("일부 원천은 이전 성공 발행 자료입니다. 최신 수집 상태를 확인해 주세요.");
  const balanceLabels: Array<[keyof NonNullable<DailyProductsAggregate["scopeBalances"]>, string]> = [
    ["unallocatedAdSpend", "미배분 광고비"], ["unallocatedExpense", "미배분 공통비"], ["unallocatedShippingIncome", "미배분 배송수입"],
    ["unclassifiedRevenue", "미분류 매출"], ["unclassifiedProfitBeforeAds", "미분류 광고 전 이익"]
  ];
  const reconciliation = balanceLabels.map(([key, label]) => ({ key, label,
    current: data.allProducts.current.scopeBalances?.[key] ?? null, previous: data.allProducts.previous.scopeBalances?.[key] ?? null }));
  return { date, previousDate, snapshotHash: data.summary.snapshotHash, scopeLabel, rows, totals, warnings, provisional: data.summary.provisional, reconciliation,
    ...(data.summary.resultBasis === "NATIVE_FINAL" ? { resultBasis: "NATIVE_FINAL" as const,
      sourcePublicationTimes: data.summary.asOfBySource.filter(source => source.date === date) } : {}),
    exportActivityVersion: data.exportActivityVersion };
}
