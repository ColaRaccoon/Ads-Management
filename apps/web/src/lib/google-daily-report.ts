import type { GoogleCampaignRow, GoogleCreativeRow, GoogleProfitRow, GoogleReportResponse } from "../types/google";
import { googleFilterQuery, type GoogleDateFilters } from "./google-date-filters";
import { loadGoogleProfitProducts } from "./google-profit-data";
import { googleMoney, googleNumber, googleRatio } from "./google-display";
import { googleProfitView } from "./google-profit-view";

export const GOOGLE_DAILY_COLUMNS = [
  { key: "creative", label: "소재" },
  { key: "adSpendKrw", label: "광고비 KRW" },
  { key: "impressions", label: "노출수" },
  { key: "clicks", label: "클릭수" },
  { key: "ctr", label: "CTR" },
  { key: "cpcKrw", label: "CPC (원)" },
  { key: "cpmKrw", label: "CPM (원)" },
  { key: "purchaseCount", label: "구매 전환수" },
  { key: "cpaKrw", label: "구매 CPA (원)" },
  { key: "purchaseValueKrw", label: "구매 전환매출" },
  { key: "purchaseRoas", label: "Google ROAS" },
  { key: "videoViews", label: "영상 조회수" },
  { key: "videoViewRate", label: "영상 조회율" },
  { key: "videoP25", label: "영상 25% 시청률" },
  { key: "videoP50", label: "영상 50% 시청률" },
  { key: "videoP75", label: "영상 75% 시청률" },
  { key: "videoP100", label: "영상 100% 시청률" }
] as const;
export type GoogleDailyColumnKey = (typeof GOOGLE_DAILY_COLUMNS)[number]["key"];
export type GoogleDailySettings = { query: string; spendOnly: boolean; columns: GoogleDailyColumnKey[] };
export const GOOGLE_DAILY_SETTINGS_KEY = "google-daily-report-settings-v2";
export const DEFAULT_GOOGLE_DAILY_SETTINGS: GoogleDailySettings = {
  query: "", spendOnly: false, columns: GOOGLE_DAILY_COLUMNS.map(column => column.key)
};
export function normalizeGoogleDailySettings(value: unknown): GoogleDailySettings {
  if (!value || typeof value !== "object") return DEFAULT_GOOGLE_DAILY_SETTINGS;
  const saved = value as Record<string, unknown>;
  return {
    query: typeof saved.query === "string" ? saved.query : "",
    spendOnly: saved.spendOnly === true,
    columns: GOOGLE_DAILY_COLUMNS.filter(column => column.key === "creative" ||
      !Array.isArray(saved.columns) || saved.columns.includes(column.key)).map(column => column.key)
  };
}

/** Like Meta Daily Report, the selected end date is the single report day. */
export function googleDailyQueries(filters: GoogleDateFilters) {
  const reportDate = filters.to;
  const previous = new Date(`${reportDate}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDate = previous.toISOString().slice(0, 10);
  return {
    reportDate, previousDate,
    current: googleFilterQuery({ ...filters, from: reportDate, to: reportDate }),
    previous: googleFilterQuery({ ...filters, from: previousDate, to: previousDate })
  };
}

export const googleCampaignKey = (row: GoogleCampaignRow) => JSON.stringify([row.connectionId, row.customerId, row.campaignId]);
export const googleCreativeKey = (row: GoogleCreativeRow) => JSON.stringify([row.connectionId, row.customerId, row.adGroupId, row.adId]);
export function googleDailyCreativeTotals(data: GoogleReportResponse) {
  const rows = data.creatives ?? [];
  const complete = data.creativeCompleteness?.complete === true;
  const spend = complete && rows.every(row => row.adSpendKrw !== null) ? rows.reduce((sum, row) => sum + row.adSpendKrw!, 0) : null;
  const purchases = complete ? rows.reduce((sum, row) => sum + row.purchaseCount, 0) : null;
  const revenue = complete && rows.every(row => row.purchaseValueKrw !== null) ? rows.reduce((sum, row) => sum + row.purchaseValueKrw!, 0) : null;
  return { spend, purchases, revenue, cpa: spend !== null && purchases !== null && purchases > 0 ? spend / purchases : null,
    roas: spend !== null && spend > 0 && revenue !== null ? revenue / spend : null };
}
const CHANGED = "조회 중 Google 데이터가 변경되었거나 일부 데이터를 읽지 못했습니다. 새로고침해 주세요.";
const snapshot = (data: GoogleReportResponse) => JSON.stringify([
  data.range, data.summary, data.completeness, data.reconciliation, data.coverage
]);

/** Each endpoint paginates independently. Never infer campaign count from product count. */
export async function loadGoogleDailyReport(
  query: string,
  fetchReport: (endpoint: "profit" | "creatives", query: string) => Promise<GoogleReportResponse>
): Promise<GoogleReportResponse & { creatives: GoogleCreativeRow[]; creativeCompleteness: NonNullable<GoogleReportResponse["creativeCompleteness"]> }> {
  const products = await loadGoogleProfitProducts(query, params => fetchReport("profit", params));
  const params = new URLSearchParams(query);
  params.set("pageSize", "50");
  const creatives: GoogleCreativeRow[] = [];
  let creativeCompleteness: GoogleReportResponse["creativeCompleteness"];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    params.set("page", String(page));
    const data = await fetchReport("creatives", params.toString());
    const pagination = data.pagination;
    if (!Number.isSafeInteger(pagination.total) || pagination.total < 0 ||
      pagination.page !== page || pagination.pageSize !== 50 ||
      (total !== undefined && total !== pagination.total) || snapshot(data) !== snapshot(products) ||
      !Array.isArray(data.creatives) || !data.creativeCompleteness ||
      (page > 1 && JSON.stringify(creativeCompleteness) !== JSON.stringify(data.creativeCompleteness)) ||
      data.creatives.length !== Math.min(50, Math.max(0, pagination.total - (page - 1) * 50))) throw new Error(CHANGED);
    creativeCompleteness = data.creativeCompleteness;
    total = pagination.total;
    for (const creative of data.creatives) {
      const key = googleCreativeKey(creative);
      if (seen.has(key)) throw new Error(CHANGED);
      seen.add(key);
      creatives.push(creative);
    }
    if (creatives.length === total) return { ...products, creatives, creativeCompleteness };
  }
}

export type GoogleDailyGroup = { productId: string | null; productName: string; sales: GoogleProfitRow; creatives: GoogleCreativeRow[] };
export function buildGoogleDailyGroups(data: GoogleReportResponse, productName: (id: string | null) => string, settings: Pick<GoogleDailySettings, "query" | "spendOnly">): GoogleDailyGroup[] {
  const groups = new Map(data.products.map(row => [row.productId, {
    productId: row.productId, productName: productName(row.productId), sales: row, creatives: [] as GoogleCreativeRow[]
  }]));
  for (const campaign of data.creatives ?? []) {
    // A one-day campaign can only belong to one product; never duplicate its cost across cards.
    if (campaign.productIds.length > 1 || (campaign.hasUnmapped && campaign.productIds.length)) throw new Error(CHANGED);
    const group = groups.get(campaign.productIds[0] ?? null);
    if (!group) throw new Error(CHANGED);
    group.creatives.push(campaign);
  }
  const needle = settings.query.trim().toLocaleLowerCase("ko-KR");
  return [...groups.values()].filter(group => {
    const hasSpend = group.creatives.some(row => /^\d+$/.test(row.costMicros) && BigInt(row.costMicros) > 0n);
    return (!settings.spendOnly || hasSpend) && (!needle || group.productName.toLocaleLowerCase("ko-KR").includes(needle) ||
      group.creatives.some(row => [row.adName, row.campaignName, row.adGroupName, row.adId, row.adGroupId, row.campaignId, ...row.assets.map(asset => asset.name)].some(name => name.toLocaleLowerCase("ko-KR").includes(needle))));
  });
}

const INCOMPLETE_AD = new Set(["GOOGLE_COLLECTION_INCOMPLETE", "SOURCE_SELECTION_REQUIRED", "TIME_ZONE_MISMATCH", "TIME_ZONE_UNKNOWN", "CAFE24_TIME_ZONE_MISMATCH"]);
export function googleDailyCreativeValue(row: GoogleCreativeRow | undefined, key: GoogleDailyColumnKey): number | string | null {
  if (!row) return null;
  if (key === "creative") return row.adName;
  if (row.warningCodes.some(code => INCOMPLETE_AD.has(code))) return null;
  if (key === "cpmKrw") return row.impressions > 0 && row.adSpendKrw !== null ? row.adSpendKrw / row.impressions * 1000 : null;
  return key === "adSpendKrw" ? row.adSpendKrwExact : row[key];
}
export function formatGoogleDailyValue(value: string | number | null | undefined, key: GoogleDailyColumnKey): string {
  if (key === "creative") return value == null ? "—" : String(value);
  if (key === "ctr" || key === "videoViewRate" || key.startsWith("videoP")) return googleRatio(value == null ? null : Number(value), true, 2);
  if (key === "purchaseRoas") return googleRatio(value == null ? null : Number(value), false, 2);
  if (key === "impressions" || key === "clicks" || key === "videoViews") return googleNumber(value == null ? null : Number(value));
  if (key === "purchaseCount") return value == null ? "—" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(Number(value));
  return googleMoney(value);
}

/** Shared order for the screen and workbook; keep missing values distinct from zero. */
export function googleDailySalesMetrics(row: GoogleProfitRow) {
  const view = googleProfitView(row);
  return [
    { label: "판매수량", value: row.quantity, kind: "number" },
    { label: "설정가 매출", value: row.revenueKrw, kind: "money" },
    { label: "수집 판매금액", value: row.collectedRevenueKrw, kind: "money" },
    { label: "상품 비용", value: row.grossCostKrw, kind: "money" },
    { label: "광고비", value: row.adSpendKrw, kind: "money" },
    { label: "쿠폰 차감", value: row.couponDeductionKrw, kind: "money" },
    { label: "총비용", value: view.totalCostKrw, kind: "money" },
    { label: "쿠폰 적용 전 마진", value: view.marginBeforeCouponKrw, kind: "money" },
    { label: "최종 순마진", value: row.marginKrw, kind: "money" },
    { label: "마진율", value: row.marginRate, kind: "percent" }
  ] as const;
}
