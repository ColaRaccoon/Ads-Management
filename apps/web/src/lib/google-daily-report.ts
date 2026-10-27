import type { GoogleCampaignRow, GoogleProfitRow, GoogleReportResponse } from "../types/google";
import { googleFilterQuery, type GoogleDateFilters } from "./google-date-filters";
import { loadGoogleProfitProducts } from "./google-profit-data";
import { googleMoney, googleNumber, googleRatio } from "./google-display";
import { googleProfitView } from "./google-profit-view";

export const GOOGLE_DAILY_COLUMNS = [
  { key: "campaign", label: "캠페인" },
  { key: "adSpendKrw", label: "광고비 KRW" },
  { key: "impressions", label: "노출수" },
  { key: "clicks", label: "클릭수" },
  { key: "ctr", label: "CTR" },
  { key: "cpcKrw", label: "CPC (원)" },
  { key: "cpmKrw", label: "CPM (원)" }
] as const;
export type GoogleDailyColumnKey = (typeof GOOGLE_DAILY_COLUMNS)[number]["key"];
export type GoogleDailySettings = { query: string; spendOnly: boolean; columns: GoogleDailyColumnKey[] };
export const GOOGLE_DAILY_SETTINGS_KEY = "google-daily-report-settings-v1";
export const DEFAULT_GOOGLE_DAILY_SETTINGS: GoogleDailySettings = {
  query: "", spendOnly: false, columns: GOOGLE_DAILY_COLUMNS.map(column => column.key)
};
export function normalizeGoogleDailySettings(value: unknown): GoogleDailySettings {
  if (!value || typeof value !== "object") return DEFAULT_GOOGLE_DAILY_SETTINGS;
  const saved = value as Record<string, unknown>;
  return {
    query: typeof saved.query === "string" ? saved.query : "",
    spendOnly: saved.spendOnly === true,
    columns: GOOGLE_DAILY_COLUMNS.filter(column => column.key === "campaign" ||
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
const CHANGED = "조회 중 Google 데이터가 변경되었거나 일부 데이터를 읽지 못했습니다. 새로고침해 주세요.";
const snapshot = (data: GoogleReportResponse) => JSON.stringify([
  data.range, data.summary, data.completeness, data.reconciliation, data.coverage
]);

/** Each endpoint paginates independently. Never infer campaign count from product count. */
export async function loadGoogleDailyReport(
  query: string,
  fetchReport: (endpoint: "profit" | "campaigns", query: string) => Promise<GoogleReportResponse>
): Promise<GoogleReportResponse> {
  const products = await loadGoogleProfitProducts(query, params => fetchReport("profit", params));
  const params = new URLSearchParams(query);
  params.set("pageSize", "50");
  const campaigns: GoogleCampaignRow[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    params.set("page", String(page));
    const data = await fetchReport("campaigns", params.toString());
    const pagination = data.pagination;
    if (!Number.isSafeInteger(pagination.total) || pagination.total < 0 ||
      pagination.page !== page || pagination.pageSize !== 50 ||
      (total !== undefined && total !== pagination.total) || snapshot(data) !== snapshot(products) ||
      data.campaigns.length !== Math.min(50, Math.max(0, pagination.total - (page - 1) * 50))) throw new Error(CHANGED);
    total = pagination.total;
    for (const campaign of data.campaigns) {
      const key = googleCampaignKey(campaign);
      if (seen.has(key)) throw new Error(CHANGED);
      seen.add(key);
      campaigns.push(campaign);
    }
    if (campaigns.length === total) return { ...products, campaigns };
  }
}

export type GoogleDailyGroup = { productId: string | null; productName: string; sales: GoogleProfitRow; campaigns: GoogleCampaignRow[] };
export function buildGoogleDailyGroups(data: GoogleReportResponse, productName: (id: string | null) => string, settings: Pick<GoogleDailySettings, "query" | "spendOnly">): GoogleDailyGroup[] {
  const groups = new Map(data.products.map(row => [row.productId, {
    productId: row.productId, productName: productName(row.productId), sales: row, campaigns: [] as GoogleCampaignRow[]
  }]));
  for (const campaign of data.campaigns) {
    // A one-day campaign can only belong to one product; never duplicate its cost across cards.
    if (campaign.productIds.length > 1 || (campaign.hasUnmapped && campaign.productIds.length)) throw new Error(CHANGED);
    const group = groups.get(campaign.productIds[0] ?? null);
    if (!group) throw new Error(CHANGED);
    group.campaigns.push(campaign);
  }
  const needle = settings.query.trim().toLocaleLowerCase("ko-KR");
  return [...groups.values()].filter(group => {
    const hasSpend = group.campaigns.some(row => /^\d+$/.test(row.costMicros) && BigInt(row.costMicros) > 0n);
    return (!settings.spendOnly || hasSpend) && (!needle || group.productName.toLocaleLowerCase("ko-KR").includes(needle) ||
      group.campaigns.some(row => row.campaignName.toLocaleLowerCase("ko-KR").includes(needle)));
  });
}

const INCOMPLETE_AD = new Set(["GOOGLE_COLLECTION_INCOMPLETE", "SOURCE_SELECTION_REQUIRED", "TIME_ZONE_MISMATCH", "TIME_ZONE_UNKNOWN", "CAFE24_TIME_ZONE_MISMATCH"]);
export function googleDailyCampaignValue(row: GoogleCampaignRow | undefined, key: GoogleDailyColumnKey): number | string | null {
  if (!row) return null;
  if (key === "campaign") return row.campaignName;
  if (row.warningCodes.some(code => INCOMPLETE_AD.has(code))) return null;
  if (key === "cpmKrw") return row.impressions > 0 && row.adSpendKrw !== null ? row.adSpendKrw / row.impressions * 1000 : null;
  return key === "adSpendKrw" ? row.adSpendKrwExact : row[key];
}
export function formatGoogleDailyValue(value: string | number | null | undefined, key: GoogleDailyColumnKey): string {
  if (key === "campaign") return value == null ? "—" : String(value);
  if (key === "ctr") return googleRatio(value == null ? null : Number(value), true);
  if (key === "impressions" || key === "clicks") return googleNumber(value == null ? null : Number(value));
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
