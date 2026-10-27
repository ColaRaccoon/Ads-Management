import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleCampaignRow, GoogleProfitRow, GoogleReportResponse } from "../types/google";
import { buildGoogleDailyGroups, DEFAULT_GOOGLE_DAILY_SETTINGS, googleCampaignKey, googleDailyCampaignValue, googleDailyQueries, loadGoogleDailyReport, normalizeGoogleDailySettings } from "./google-daily-report";
import { buildGoogleDailyXlsx, buildGoogleDailyXlsxInput } from "./google-daily-xlsx";
import type { XlsxRow } from "./xlsx";

function product(productId: string | null): GoogleProfitRow {
  return { productId, date: "2026-10-26", quantity: 2, lineCount: 2, revenueKrw: 10000, knownRevenueKrw: 10000,
    collectedRevenueKrw: 9000, grossCostKrw: 6000, couponDeductionKrw: 1000, adSpendKrw: 4000.125, adSpendKrwExact: "4000.125",
    knownAdSpendKrw: 4000.125, marginKrw: -1000.125, calculatedMarginKrw: -1000.125, marginRate: -0.1000125, roas: 2.5,
    impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 400.0125, costPerSaleKrw: 2000.0625, priceMismatchCount: 0, complete: true, warningCodes: [] };
}
function campaign(id: string, productId: string | null = "p1"): GoogleCampaignRow {
  return { connectionId: "google-1", customerId: "123", campaignId: id, campaignName: `캠페인 ${id}`, currencyCode: "KRW",
    productIds: productId ? [productId] : [], hasUnmapped: productId === null, costMicros: "4000125000", adSpendKrw: 4000.125,
    adSpendKrwExact: "4000.125", impressions: 1000, clicks: 10, ctr: 0.01, cpcKrw: 400.0125, warningCodes: [] };
}
function report(products = [product("p1")], campaigns = [campaign("c1")]): GoogleReportResponse {
  return { range: { from: "2026-10-26", to: "2026-10-26" }, products, campaigns, daily: [], unmappedSales: [],
    summary: { ...product(null), calculatedProductsMarginKrw: -1000.125, allocatedAdSpendKrw: 4000.125, unallocatedAdSpendKrw: 0, unmappedSalesCount: 0 },
    pagination: { page: 1, pageSize: 50, total: products.length }, coverage: [], notices: [],
    completeness: { complete: true, missingGoogleDates: [], missingCafe24Dates: [], completeDates: ["2026-10-26"], warningCodes: [] },
    reconciliation: { balanced: true, byCurrency: [], collectedAdSpendKrwExact: "4000.125", allocatedAdSpendKrwExact: "4000.125", unallocatedAdSpendKrwExact: "0" } };
}
const filters = { from: "2026-10-01", to: "2026-10-26", productId: "p1", connectionId: "g", cafe24ConnectionId: "c" };

test("daily report uses range end and previous calendar day, preserving URL filters", () => {
  for (const [end, previous] of [["2026-10-26", "2026-10-25"], ["2026-01-01", "2025-12-31"], ["2024-03-01", "2024-02-29"]]) {
    const dates = googleDailyQueries({ ...filters, to: end });
    assert.equal(dates.previousDate, previous);
    const query = new URLSearchParams(dates.current);
    assert.equal(query.get("from"), end); assert.equal(query.get("to"), end);
    assert.equal(query.get("productId"), "p1"); assert.equal(query.get("cafe24ConnectionId"), "c");
  }
});

test("all product and campaign pages load independently and retain server summary", async () => {
  const data = report(Array.from({ length: 51 }, (_, i) => product(`p${i}`)), Array.from({ length: 101 }, (_, i) => campaign(`c${i}`, `p${i % 51}`)));
  const calls: string[] = [];
  const loaded = await loadGoogleDailyReport("from=2026-10-26&to=2026-10-26", async (endpoint, query) => {
    const p = new URLSearchParams(query), page = Number(p.get("page")); calls.push(`${endpoint}:${page}`);
    return { ...data, products: data.products.slice((page - 1) * 50, page * 50), campaigns: data.campaigns.slice((page - 1) * 50, page * 50),
      pagination: { page, pageSize: 50, total: endpoint === "profit" ? 51 : 101 } };
  });
  assert.deepEqual(calls, ["profit:1", "profit:2", "campaigns:1", "campaigns:2", "campaigns:3"]);
  assert.equal(loaded.products.length, 51); assert.equal(loaded.campaigns.length, 101);
  assert.deepEqual(loaded.summary, data.summary);
});

test("campaign paging rejects omissions, duplicates, count/range/summary/coverage drift and read failures", async () => {
  for (const variant of ["missing", "duplicate", "count", "range", "summary", "coverage", "failure"] as const) {
    const data = report([product("p1")], Array.from({ length: 51 }, (_, i) => campaign(`c${i}`)));
    await assert.rejects(loadGoogleDailyReport("from=2026-10-26&to=2026-10-26", async (endpoint, query) => {
      const page = Number(new URLSearchParams(query).get("page"));
      if (endpoint === "profit") return { ...data, campaigns: [], pagination: { page, pageSize: 50, total: 1 } };
      const result = structuredClone({ ...data, campaigns: data.campaigns.slice((page - 1) * 50, page * 50), pagination: { page, pageSize: 50, total: 51 } });
      if (page === 2) {
        if (variant === "missing") result.campaigns = [];
        if (variant === "duplicate") result.campaigns = [data.campaigns[0]];
        if (variant === "count") result.pagination.total = 52;
        if (variant === "range") result.range.to = "2026-10-25";
        if (variant === "summary") result.summary.quantity++;
        if (variant === "coverage") result.completeness.complete = false;
        if (variant === "failure") throw Error("API unavailable");
      }
      return result;
    }));
  }
});

test("empty completed days load without inventing rows", async () => {
  const data = report([], []);
  const loaded = await loadGoogleDailyReport("from=2026-10-26&to=2026-10-26", async () => data);
  assert.deepEqual(loaded.products, []); assert.deepEqual(loaded.campaigns, []);
});

test("groups retain sales-only products, unallocated spend, and full product campaigns on search", () => {
  const data = report([product("p1"), product("sales-only"), product(null)], [campaign("c1"), campaign("c2"), campaign("unmapped", null)]);
  const groups = buildGoogleDailyGroups(data, id => id ?? "미연결", { query: "", spendOnly: false });
  assert.equal(groups.length, 3); assert.equal(groups[1].campaigns.length, 0); assert.equal(groups[2].campaigns.length, 1);
  const filtered = buildGoogleDailyGroups(data, id => id ?? "미연결", { query: "c1", spendOnly: false });
  assert.equal(filtered.length, 1); assert.equal(filtered[0].campaigns.length, 2);
  assert.equal(buildGoogleDailyGroups(data, id => id ?? "미연결", { query: "", spendOnly: true }).length, 2);
  data.campaigns[0].productIds = ["p1", "sales-only"];
  assert.throws(() => buildGoogleDailyGroups(data, String, DEFAULT_GOOGLE_DAILY_SETTINGS));
});

test("previous day identity includes account, and incomplete or absent metrics never become zero", () => {
  const current = campaign("same");
  assert.notEqual(googleCampaignKey(current), googleCampaignKey({ ...current, connectionId: "other" }));
  assert.ok(Math.abs(Number(googleDailyCampaignValue(current, "cpmKrw")) - 4000.125) < 1e-9);
  assert.equal(googleDailyCampaignValue(undefined, "clicks"), null);
  assert.equal(googleDailyCampaignValue({ ...current, clicks: 0 }, "clicks"), 0);
  assert.equal(googleDailyCampaignValue({ ...current, warningCodes: ["GOOGLE_COLLECTION_INCOMPLETE"] }, "clicks"), null);
  assert.equal(googleDailyCampaignValue({ ...current, adSpendKrw: null, adSpendKrwExact: null }, "adSpendKrw"), null);
});

test("settings stay channel-specific and cannot remove the campaign identity column", () => {
  assert.deepEqual(normalizeGoogleDailySettings({ columns: [], query: "검색", spendOnly: true }), { columns: ["campaign"], query: "검색", spendOnly: true });
  assert.deepEqual(normalizeGoogleDailySettings({ columns: ["unknown", "clicks", "clicks"] }).columns, ["campaign", "clicks"]);
  assert.deepEqual(normalizeGoogleDailySettings(null), DEFAULT_GOOGLE_DAILY_SETTINGS);
});

test("daily workbook includes selected columns, current/previous values, sales margins and blank unknowns", () => {
  const data = report(); data.products[0].marginKrw = null; data.products[0].complete = false;
  data.campaigns[0].campaignName = '=HYPERLINK("https://example.com")';
  const previous = report(); previous.campaigns[0].clicks = 3;
  const input = { reportDate: "2026-10-26", previousDate: "2026-10-25", data, previous,
    groups: buildGoogleDailyGroups(data, () => "제품 A", DEFAULT_GOOGLE_DAILY_SETTINGS), columns: ["campaign", "clicks"] as const, filterLabel: "전체" };
  const request = { ...input, columns: [...input.columns] };
  const workbook = buildGoogleDailyXlsxInput(request);
  const rows = workbook.rows.map(row => Array.isArray(row) ? row : (row as XlsxRow).cells);
  const campaignRow = rows.find(row => row[0]?.value === `${data.campaigns[0].campaignName}\n123 · c1`)!;
  assert.equal(campaignRow[1].value, 10); assert.equal(campaignRow[2].value, 3);
  const sales = rows.find(row => row[0]?.value === "제품 A")!;
  assert.equal(sales[2].value, 10000); assert.equal(sales[3].value, 9000); assert.equal(sales[9].value, "");
  assert.equal(rows.some(row => row.some(cell => cell.value === "CPC (원)\n2026-10-26")), false);
  const bytes = buildGoogleDailyXlsx(request);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const xml = new TextDecoder().decode(bytes);
  assert.ok(!xml.includes("<f>")); assert.ok(xml.includes("Google Daily Report"));
});
