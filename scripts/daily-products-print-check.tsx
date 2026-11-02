/** Local synthetic-data visual/print regression. No API, DB or production credentials. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { DailyReportSheet } from "../apps/web/src/features/product-performance/daily-report";
import { DailyProductsTable } from "../apps/web/src/features/product-performance/daily-products-table";
import { buildDailyProductsReport, type DailyProductsAggregate, type DailyProductsResponse } from "../apps/web/src/features/product-performance/daily-products-model";
import { buildDailyProductsXlsx } from "../apps/web/src/features/product-performance/daily-products-xlsx";
import { testData, testEnvelope, testFilters } from "../apps/web/src/features/product-performance/test-fixture";
import { authCoordinator } from "../apps/web/src/features/auth/auth-coordination";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const output = path.resolve("reports/daily-products-export");
const count = Number(process.argv[2] ?? 100);
assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 5000);
const filters = testFilters({ from: "2026-10-31", to: "2026-11-01", compareFrom: "2026-10-31", compareTo: "2026-10-31", compareMode: "custom", productName: "" });

function aggregate(factor: number, partial = false): DailyProductsAggregate {
  const display = (value: number) => ({ value: value.toFixed(6), state: partial ? "PARTIAL" as const : "COMPLETE" as const, availableSources: ["CAFE24" as const], missingSources: partial ? ["CAFE24" as const] : [] });
  const market = (marketplace: string, revenue: number, spend: number, profit: number) => ({ marketplace,
    revenue: String(revenue), completeRevenue: partial ? null : String(revenue), adSpend: String(spend), estimatedProfit: partial ? null : String(profit),
    display: { revenue: display(revenue), adSpend: display(spend), estimatedProfit: display(profit) } });
  const knownTotals = { revenue: String(2500000 * factor), adSpend: String(450000 * factor), estimatedProfit: String(650000 * factor), profitBeforeAds: String(1100000 * factor), mer: "5.55555555" };
  return { knownTotals, completeTotals: partial ? { revenue: null, adSpend: null, estimatedProfit: null, profitBeforeAds: null, mer: null } : knownTotals,
    byMarketplace: [market("CAFE24_META", 1000000 * factor, 200000 * factor, 300000 * factor), market("COUPANG", 700000 * factor, 100000 * factor, 200000 * factor),
      market("NAVER_SMARTSTORE", 500000 * factor, 80000 * factor, 200000 * factor), market("CAFE24_YOUTUBE", 300000 * factor, 70000 * factor, -50000 * factor)],
    byMedium: [], isEstimate: partial, scopeBalances: { unallocatedAdSpend: "0", unallocatedExpense: "0", shippingIncome: "0", unallocatedShippingIncome: "0", unclassifiedRevenue: "0", unclassifiedProfitBeforeAds: "0" } };
}

async function main() {
  await mkdir(output, { recursive: true });
  const data = testData(filters), base = testEnvelope(filters);
  data.timeseries.items = [filters.from, filters.to].map((date, i) => ({ ...base, ...aggregate(i === 0 ? count * .9 : count), date, bucketFrom: date, bucketTo: date, partial: false }));
  data.timeseries.total = 2;
  const response: DailyProductsResponse = { ...data, reportDate: filters.to, previousDate: filters.from, totalProducts: count, nextCursor: null,
    products: Array.from({ length: count }, (_, i) => ({ productKey: `synthetic-${String(i).padStart(5, "0")}`,
      productName: `제품 ${String(i + 1).padStart(4, "0")} ${i % 11 === 0 ? "긴 이름 테스트 운동용 무릎 보호대 프리미엄 세트" : "성능 확인용"}`,
      active: i % 7 !== 0, historical: i % 17 === 0, current: aggregate(i % 19 === 0 ? 0 : i % 23 === 0 ? 100 : 1, i % 13 === 0),
      previous: aggregate(i % 5 === 0 ? 0 : .9, i % 13 === 1) })),
    allProducts: { current: aggregate(count), previous: aggregate(count * .9) } };
  const started = performance.now();
  const report = buildDailyProductsReport(response, filters.to, filters);
  const modelMs = performance.now() - started;
  const html = renderToStaticMarkup(<div className="app-shell"><aside className="sidebar">NOT PRINTED</aside><main className="main"><div className="topbar">NOT PRINTED</div><div className="integrated-performance-page"><section className="integrated-daily-root" data-print-mode="all" data-print-ready="true"><DailyReportSheet data={data} date={filters.to} filters={filters} /><DailyProductsTable report={report} /></section></div></main></div>);
  const css = (await Promise.all(["apps/web/src/app/globals.css", "apps/web/src/features/product-performance/daily-report.css", "apps/web/src/features/product-performance/daily-products.css"].map(file => readFile(file, "utf8")))).join("\n");
  const document = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>전체 제품 출력 검증 — 합성 데이터</title><style>${css}</style></head><body>${html}</body></html>`;
  await writeFile(path.join(output, "print-fixture.html"), document);
  const excelStart = performance.now();
  const xlsx = buildDailyProductsXlsx(report);
  const xlsxMs = performance.now() - excelStart;
  await writeFile(path.join(output, "synthetic-daily-products.xlsx"), xlsx);
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.setContent(document, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator(".daily-products-table tbody tr[data-product-key]").count(), count + 1);
    assert.equal(await page.locator(".daily-products-table col").count(), 16);
    await page.locator(".daily-products-report").screenshot({ path: path.join(output, "screen-detail.png") });
    await page.emulateMedia({ media: "print" });
    const clips = await page.locator(".daily-products-money").evaluateAll((cells: HTMLElement[]) => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => ({ value: cell.textContent, width: cell.clientWidth, scroll: cell.scrollWidth })));
    // Screen emulation is not paged layout; PDF inspection below is authoritative.
    await page.pdf({ path: path.join(output, "all.pdf"), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    for (const mode of ["summary", "detail"] as const) {
      await page.locator(".integrated-daily-root").evaluate((root: HTMLElement, value: string) => { root.dataset.printMode = value; }, mode);
      if (mode === "summary") assert.equal(await page.locator(".daily-products-report").isVisible(), false);
      if (mode === "detail") assert.equal(await page.locator(".integrated-daily-report").isVisible(), false);
      await page.pdf({ path: path.join(output, `${mode}.pdf`), preferCSSPageSize: true, printBackground: true });
    }
    await writeFile(path.join(output, "measurements.json"), JSON.stringify({ products: count, modelMs, xlsxMs, xlsxBytes: xlsx.length, screenPrintEmulationOverflow: clips, result: "PASS", data: "synthetic" }, null, 2));
    console.log(JSON.stringify({ products: count, modelMs, xlsxMs, xlsxBytes: xlsx.length, output }));
  } finally { await browser.close(); }
}

main().finally(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close()).catch(error => { console.error(error); process.exitCode = 1; });
