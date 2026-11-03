/** Real production web bundle + synthetic APIs only. Never connects to a business API or database. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import JSZip from "jszip";

const origin = process.argv[2] ?? "http://127.0.0.1:3317";
const target = new URL(origin);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Only a local web server is allowed");
const output = path.resolve("reports/daily-products-export/browser");
const platforms = ["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"];
const reportDate = "2026-10-29";
const before = date => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const user = { user: { id: "synthetic-export-user", username: "synthetic-only", email: null, name: "합성 출력 검증", role: "USER", isActive: true, inviteStatus: "ACTIVE" }, permissions: ["data.read"], authorizationVersion: "synthetic-v1" };
const options = {
  products: Array.from({ length: 3 }, (_, i) => ({ productName: `합성 제품 ${i + 1}`, active: i !== 2, historical: i === 2 })),
  scopes: platforms.map(platform => ({ platform, scopeKey: "synthetic-store", label: `${platform} 검증 계정` })),
  platformOptions: platforms.map(key => ({ key, components: ["SALE", "AD_SPEND"], defaultIncluded: true, available: true })),
  availableDateRanges: platforms.map(platform => ({ platform, scopeKey: "synthetic-store", from: "2026-10-01", to: reportDate })),
  defaultSelection: { platforms, from: "2026-10-01", to: reportDate }
};

function aggregate(factor = 1) {
  const display = value => ({ value: String(value), state: "COMPLETE", availableSources: ["CAFE24"], missingSources: [] });
  const market = (marketplace, revenue, adSpend, estimatedProfit) => ({ marketplace, revenue: String(revenue), completeRevenue: String(revenue), adSpend: String(adSpend), estimatedProfit: String(estimatedProfit), display: { revenue: display(revenue), adSpend: display(adSpend), estimatedProfit: display(estimatedProfit) } });
  const knownTotals = { revenue: String(2500000 * factor), adSpend: String(450000 * factor), estimatedProfit: String(650000 * factor), profitBeforeAds: String(1100000 * factor), mer: "5.5555555555" };
  return { knownTotals, completeTotals: { ...knownTotals }, productProfitSubtotal: knownTotals.estimatedProfit,
    byMarketplace: [market("CAFE24_META", 1000000 * factor, 200000 * factor, 300000 * factor), market("COUPANG", 700000 * factor, 100000 * factor, 200000 * factor), market("NAVER_SMARTSTORE", 500000 * factor, 80000 * factor, 200000 * factor), market("CAFE24_YOUTUBE", 300000 * factor, 70000 * factor, -50000 * factor)],
    byMedium: ["META", "GOOGLE", "NAVER_DA", "COUPANG_ADS"].map(medium => ({ medium, adSpend: "100", completeAdSpend: "100", displayAdSpend: display(100), share: "25" })),
    unallocatedExpenses: [], unallocatedAdSpends: [], unclassifiedSales: [],
    scopeBalances: { unallocatedAdSpend: "0", unallocatedExpense: "0", shippingIncome: "0", unallocatedShippingIncome: "0", unclassifiedRevenue: "0", unclassifiedProfitBeforeAds: "0" },
    isEstimate: false, issues: [], notApplicable: { revenue: [], adSpend: [] } };
}

function response(query, behavior) {
  const { revision, mismatch: mismatched = false, count = 3, density = false, inactiveEvery = 0, missingActivity = false, emptyActivity = false } = behavior;
  const date = query.get("to"), previousDate = before(date), selectedPlatforms = JSON.parse(query.get("platforms"));
  const current = aggregate(emptyActivity ? 0 : count), previous = aggregate(count * .9);
  const metricComparison = Object.fromEntries(Object.keys(current.knownTotals).map(key => [key, { current: current.knownTotals[key], previous: previous.knownTotals[key], change: "0", changePct: "0", reason: null, currentDailyAverage: current.knownTotals[key], previousDailyAverage: previous.knownTotals[key] }]));
  const envelope = { ...current, contractVersion: "product-performance-v1.1.0", snapshotHash: revision,
    ...(process.env.QA_NATIVE_RESULTS === "true" ? { resultBasis: "NATIVE_FINAL" } : {}),
    selection: { selectedPlatforms, excludedPlatforms: platforms.filter(p => !selectedPlatforms.includes(p)), scopeKeys: ["synthetic-store"], productName: query.get("productName") || null,
      from: query.get("from"), to: date, compareFrom: query.get("compareFrom"), compareTo: query.get("compareTo"), grain: query.get("grain"), selectionHash: query.toString() },
    selectedPlatforms, excludedPlatforms: platforms.filter(p => !selectedPlatforms.includes(p)), scopeLabel: "선택 범위", profitLabel: "추정 순이익",
    metricAvailability: { state: "SALE_AND_AD", revenue: true, adSpend: true, profitBeforeAds: true, estimatedProfit: true, mer: true },
    versions: { calculationVersion: "synthetic" }, latestConfigurationVersions: {}, requestedCalculationVersion: "synthetic",
    asOfBySource: process.env.QA_NATIVE_RESULTS === "true" ? platforms.map(platform => ({ platform, scopeKey: "synthetic-store", date,
      sourceAsOf: `${date}T14:00:00Z`, publishedAt: `${date}T14:05:00Z`, stale: false })) : [],
    coverage: [], comparisonCoverage: [], warnings: [], provisional: false,
    comparison: { known: metricComparison, complete: metricComparison, byMedium: [], previousByMarketplace: previous.byMarketplace, currentDays: 2, previousDays: 1, unequalPeriods: true } };
  return { ...(missingActivity ? {} : { exportActivityVersion: 3 }), reportDate: date, previousDate, totalProducts: count, nextCursor: null,
    summary: { ...envelope, items: [], total: 0, nextCursor: null },
    timeseries: { ...envelope, snapshotHash: mismatched ? `${revision}-different` : revision, items: [previousDate, date].map((day, i) => ({ ...envelope, ...(i ? current : previous), date: day, bucketFrom: day, bucketTo: day, partial: false })), total: 2, nextCursor: null },
    products: Array.from({ length: count }, (_, i) => {
      const inactive = emptyActivity || (density ? inactiveEvery > 0 && i % inactiveEvery === 1 : i === 1);
      const factor = inactive ? 0 : density ? (i % 9 === 0 ? 12345.6789 : (i % 13 + 1) / 10) : 1;
      const current = aggregate(factor), previous = aggregate(inactive ? .9 : factor * .9);
      // A few long names, eleven-digit amounts and negative profits stress the dense portrait layout.
      if (density && !inactive && i % 7 === 0) {
        current.knownTotals.estimatedProfit = String(-650000 * factor);
        current.completeTotals.estimatedProfit = current.knownTotals.estimatedProfit;
      }
      return { productKey: `synthetic-product-${i}`,
        productName: density ? `밀도 제품 ${String(i + 1).padStart(3, "0")}${i % 11 === 0 ? " 초경량 접이식 다용도 운동기구 한정판 긴 제품명 세트 3종" : ""} ${revision}` : `합성 제품 ${i + 1} ${revision}`,
        active: density ? !inactive : i !== 2, historical: density ? inactive : i === 2,
        ...(missingActivity ? {} : { exportPlatforms: inactive ? [] : density ? ["STOREFRONT", "GOOGLE", "COUPANG", "NAVER"] : [["STOREFRONT", "GOOGLE"], [], ["COUPANG", "NAVER", "STOREFRONT"]][i] }),
        current, previous };
    }),
    allProducts: { current, previous } };
}

await mkdir(output, { recursive: true });
const events = { api: [], workers: [], externalBlocked: [], unexpectedApi: [], pageErrors: [], checks: [], pdfs: [] };
const behaviors = [{ hold: true, revision: "initial" }];
const waiting = [];
let serial = 0;
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== target.origin) { events.externalBlocked.push(url.origin); await route.abort("blockedbyclient"); return; }
    if (!url.pathname.startsWith("/backend-api/")) { await route.continue(); return; }
    events.api.push({ path: url.pathname, method: route.request().method() });
    const json = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/backend-api/auth/me") { await json(user); return; }
    if (url.pathname === "/backend-api/unified-performance/selection-options") { await json(options); return; }
    if (url.pathname === "/backend-api/unified-performance/daily-products") {
      serial++;
      const behavior = behaviors.shift() ?? { revision: `auto-${serial}` };
      if (behavior.hold) await new Promise(resolve => waiting.push({ resolve, revision: behavior.revision }));
      try { await json(response(url.searchParams, behavior)); } catch (error) {
        // A changed date intentionally aborts the older read. No API is retried outside this route.
        if (!String(error).includes("Target closed") && !String(error).includes("Request is already handled")) throw error;
      }
      return;
    }
    events.unexpectedApi.push(url.pathname);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic harness has no response for this route" }) });
  });
  const page = await context.newPage();
  page.on("pageerror", error => events.pageErrors.push(error.message));
  page.on("worker", worker => events.workers.push(worker.url()));
  await page.addInitScript(() => {
    window.__dailyPrintModes = [];
    window.print = () => window.__dailyPrintModes.push(document.querySelector(".integrated-daily-root")?.dataset.printMode);
  });
  await page.goto(`${origin}/products/performance?view=daily&dailyDate=${reportDate}`, { waitUntil: "domcontentloaded" });
  const root = page.locator(".integrated-daily-root");
  const printFilter = page.getByLabel("출력 제품 필터", { exact: true });
  const downloadButton = page.getByRole("button", { name: "전체 제품 엑셀 다운로드", exact: true });
  const screenFinancialRows = () => page.locator(".daily-products-table tbody tr[data-product-key]").evaluateAll(rows => rows.map(row => ({
    key: row.dataset.productKey, cells: [...row.querySelectorAll("th,td")].map(cell => cell.textContent)
  })));
  const printedProducts = async included => {
    await page.emulateMedia({ media: "print" });
    const visible = await page.locator(".daily-products-table tbody tr[data-product-key]:not(.daily-products-total)").evaluateAll(rows => rows
      .filter(row => getComputedStyle(row).display !== "none" && row.getBoundingClientRect().height > 0).map(row => row.dataset.productKey));
    assert.deepEqual(visible.sort(), included.map(i => `synthetic-product-${i - 1}`).sort());
    assert.equal(await page.locator(".daily-products-total").isVisible(), false, "Unfiltered totals must not be printed with filtered product rows");
    await page.emulateMedia({ media: "screen" });
  };
  const savePortraitPdf = async name => {
    await page.emulateMedia({ media: "print" });
    const rules = await page.evaluate(() => {
      const collect = ruleList => [...ruleList].flatMap(rule => [rule.cssText, ...(rule.cssRules ? collect(rule.cssRules) : [])]);
      return [...document.styleSheets].flatMap(sheet => collect(sheet.cssRules));
    });
    // Chromium CSSOM serializes the default `A4 portrait` orientation as just `a4`.
    // Accept that normalized form; PDF page dimensions below independently reject landscape.
    assert.ok(rules.some(rule => /^@page\s+daily-products-detail\s*\{/i.test(rule) && /size:\s*(?:a4(?:\s+portrait)?|portrait\s+a4)\s*[;}]/i.test(rule)), "Detail @page must be A4 portrait");
    const bytes = await page.pdf({ path: path.join(output, name), preferCSSPageSize: true, printBackground: true });
    const text = bytes.toString("latin1");
    const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
      .map(match => ({ width: Number(match[3]) - Number(match[1]), height: Number(match[4]) - Number(match[2]) }));
    assert.ok(boxes.length > 0, "Chromium PDF must expose page dimensions");
    assert.ok(boxes.every(box => box.height > box.width), "Every printed page must remain portrait");
    events.pdfs.push({ file: name, pages: (text.match(/\/Type\s*\/Page\b/g) ?? []).length, dimensions: boxes, bytes: bytes.byteLength });
    await page.emulateMedia({ media: "screen" });
  };
  await downloadButton.waitFor();
  assert.equal(await downloadButton.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "요약만 인쇄", exact: true }).isDisabled(), true);
  assert.equal(await root.getAttribute("data-print-ready"), "false");
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".integrated-daily-print-not-ready").isVisible(), true);
  await page.emulateMedia({ media: "screen" });
  await page.waitForFunction(() => document.querySelector(".integrated-daily-root") !== null);
  assert.equal(waiting.length, 1); waiting.shift().resolve();
  await page.locator('.integrated-daily-root[data-print-ready="true"]').waitFor();
  assert.equal(await page.locator(".daily-products-table tbody tr[data-product-key]").count(), 4);
  assert.equal(await page.locator(".daily-products-table col").count(), 16);
  assert.match(await page.locator(".daily-products-scope").innerText(), /검증 계정/);
  assert.doesNotMatch(await page.locator(".daily-products-scope").innerText(), /synthetic-store/);
  assert.equal(await printFilter.inputValue(), "ALL");
  await printedProducts([1, 3]);
  assert.equal(await page.locator(".daily-products-table tbody tr[data-product-key]").count(), 4, "Screen retains all financial rows and total");
  events.checks.push("initial loading blocks print/export; complete 16-column report appears");
  events.checks.push("default ALL print filter includes products 1 and 3, excludes current-day inactive product 2 and unfiltered total");

  for (const [button, mode] of [["요약만 인쇄", "summary"], ["상세표만 인쇄", "detail"], ["요약 + 전체 제품 인쇄 / PDF", "all"]]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    assert.equal(await root.getAttribute("data-print-mode"), mode);
    assert.equal(await page.evaluate(() => window.__dailyPrintModes.at(-1)), mode);
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".integrated-daily-report").isVisible(), mode !== "detail");
    assert.equal(await page.locator(".daily-products-report").isVisible(), mode !== "summary");
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    assert.equal(await root.getAttribute("data-print-mode"), "all");
  }
  events.checks.push("three print modes reach window.print and reset after printing");

  behaviors.push({ hold: true, revision: "old-date" });
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await page.locator('.integrated-daily-root[data-print-ready="false"]').waitFor();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await page.locator('.integrated-daily-root[data-print-ready="true"]').waitFor();
  assert.equal(waiting.length, 1); waiting.shift().resolve();
  await page.waitForTimeout(200);
  assert.equal(await page.getByLabel("데일리 보고일").inputValue(), reportDate);
  assert.doesNotMatch(await page.locator(".daily-products-report").innerText(), /old-date/);
  events.checks.push("cancelled older-date response cannot overwrite the active date");

  behaviors.push({ mismatch: true, revision: "mixed-snapshot" }, { hold: true, revision: "fresh-snapshot" });
  const beforeRefresh = serial;
  await page.getByRole("button", { name: "다시 조회", exact: true }).click();
  await page.locator('.integrated-daily-root[data-print-ready="false"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.integrated-daily-root[data-print-ready="false"]') !== null);
  for (let attempt = 0; waiting.length === 0 && attempt < 100; attempt++) await page.waitForTimeout(20);
  assert.equal(serial, beforeRefresh + 2);
  assert.equal(await downloadButton.isDisabled(), true);
  assert.equal(waiting.length, 1); waiting.shift().resolve();
  await page.locator('.integrated-daily-root[data-print-ready="true"]').waitFor();
  assert.match(await page.locator(".daily-products-report").innerText(), /fresh-snapshot/);
  assert.doesNotMatch(await page.locator(".daily-products-report").innerText(), /mixed-snapshot/);
  events.checks.push("mismatched response is retried as a whole snapshot and export remains disabled");

  const downloaded = page.waitForEvent("download", { timeout: 30000 });
  await downloadButton.click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), `제품통합_데일리_전체제품_${reportDate}.xlsx`);
  const workbookPath = path.join(output, "browser-worker-download.xlsx");
  await download.saveAs(workbookPath);
  const zip = await JSZip.loadAsync(await readFile(workbookPath));
  const workbook = await zip.file("xl/workbook.xml").async("string");
  const report = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const data = await zip.file("xl/worksheets/sheet2.xml").async("string");
  assert.match(workbook, /전체 제품 데일리/);
  assert.match(workbook, /숫자 데이터/);
  assert.match(report, /fresh-snapshot/); assert.doesNotMatch(report, /mixed-snapshot|old-date/);
  assert.match(report, /합성 제품 3/);
  assert.doesNotMatch(report, /합성 제품 2/);
  assert.match(report, /orientation="landscape"/);
  assert.match(data, /합성 제품 3/);
  assert.doesNotMatch(data, /합성 제품 2/);
  assert.ok(events.workers.length > 0, "XLSX must be generated by the real bundled worker");
  assert.ok(events.workers.every(url => new URL(url).origin === target.origin));
  assert.equal(events.unexpectedApi.length, 0);
  assert.equal(events.externalBlocked.length, 0);
  assert.equal(events.pageErrors.length, 0);
  assert.ok(events.api.every(request => request.method === "GET"));
  events.checks.push("real bundled worker downloads both XLSX sheets from the visible fresh snapshot");
  const summaryBeforeFilter = await page.locator(".integrated-daily-report").innerHTML();
  const detailBeforeFilter = await screenFinancialRows();
  const readsBeforeFilter = events.api.length;
  await printedProducts([1, 3]);
  await page.getByRole("button", { name: "요약 + 전체 제품 인쇄 / PDF", exact: true }).click();
  await savePortraitPdf("combined-ALL.pdf");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  for (const [platform, label, included] of [["STOREFRONT", "자사몰", [1, 3]], ["GOOGLE", "구글", [1]], ["COUPANG", "쿠팡", [3]], ["NAVER", "네이버", [3]]]) {
    await printFilter.selectOption(platform);
    assert.equal(await page.locator(".integrated-daily-report").innerHTML(), summaryBeforeFilter);
    assert.deepEqual(await screenFinancialRows(), detailBeforeFilter, "Output selection never changes screen financial values");
    assert.equal(events.api.length, readsBeforeFilter, "Output product selection never changes the report query");
    assert.equal(await page.locator(".daily-products-report").getAttribute("data-print-filtered"), "true");
    assert.equal(await page.locator(".daily-products-report").getAttribute("data-print-count"), String(included.length));
    await printedProducts(included);
    if (platform === "GOOGLE") {
      await page.getByRole("button", { name: "요약 + 전체 제품 인쇄 / PDF", exact: true }).click();
      await savePortraitPdf("combined-GOOGLE.pdf");
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    }
    const pendingDownload = page.waitForEvent("download", { timeout: 30000 });
    await downloadButton.click();
    const filteredDownload = await pendingDownload;
    assert.equal(filteredDownload.suggestedFilename(), `제품통합_데일리_${label}제품_${reportDate}.xlsx`);
    const filteredPath = path.join(output, `filtered-${platform}.xlsx`);
    await filteredDownload.saveAs(filteredPath);
    const filteredZip = await JSZip.loadAsync(await readFile(filteredPath));
    for (const sheet of ["sheet1", "sheet2"]) {
      const xml = await filteredZip.file(`xl/worksheets/${sheet}.xml`).async("string");
      for (const product of [1, 2, 3]) assert.equal(xml.includes(`합성 제품 ${product} fresh-snapshot`), included.includes(product));
      assert.ok(xml.includes(`제품 필터: ${label}`));
      assert.doesNotMatch(xml, /__TOTAL__|__UNASSIGNED__/);
    }
    await page.getByRole("button", { name: "요약만 인쇄", exact: true }).click();
    assert.equal(await root.getAttribute("data-print-mode"), "summary");
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".integrated-daily-report").isVisible(), true);
    assert.equal(await page.locator(".daily-products-report").isVisible(), false);
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  }
  await printFilter.selectOption("ALL");
  assert.equal(await page.locator(".integrated-daily-report").innerHTML(), summaryBeforeFilter);
  assert.deepEqual(await screenFinancialRows(), detailBeforeFilter);
  assert.equal(events.api.length, readsBeforeFilter);
  assert.equal(events.pageErrors.length, 0);
  await printedProducts([1, 3]);
  events.checks.push("ALL and four platform filters print exactly the products in both Excel sheets; summary, screen financial rows and API reads stay unchanged");
  await page.screenshot({ path: path.join(output, "browser-daily-report.png"), fullPage: true });
  const scroll = page.locator(".daily-products-scroll");
  const beforeScroll = await page.locator(".daily-products-table tbody th").first().boundingBox();
  await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const afterScroll = await page.locator(".daily-products-table tbody th").first().boundingBox();
  assert.ok(Math.abs(beforeScroll.x - afterScroll.x) <= 1, "Product names must stay visible while scrolling");
  const lastColumn = await page.locator(".daily-products-table tbody tr").first().locator("td").last().boundingBox();
  const scrollBox = await scroll.boundingBox();
  assert.ok(lastColumn.x + lastColumn.width <= scrollBox.x + scrollBox.width + 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.locator(".daily-products-report").screenshot({ path: path.join(output, "browser-detail-right.png") });
  events.checks.push("horizontal scrolling reveals the overall columns while keeping product names fixed");
  const refreshFixture = async behavior => {
    const previousReads = serial;
    behaviors.push(behavior);
    await page.getByRole("button", { name: "다시 조회", exact: true }).click();
    await page.waitForFunction(revision => document.querySelector(".daily-products-report")?.textContent.includes(revision), behavior.revision);
    await page.locator('.integrated-daily-root[data-print-ready="true"]').waitFor();
    assert.equal(serial, previousReads + 1, "Fixture refresh performs one complete daily read");
  };
  for (const behavior of [{ revision: "missing-membership", missingActivity: true }, { revision: "empty-target", emptyActivity: true }]) {
    await refreshFixture(behavior);
    assert.equal(await root.getAttribute("data-detail-print-ready"), "false");
    assert.equal(await downloadButton.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "상세표만 인쇄", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "요약 + 전체 제품 인쇄 / PDF", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "요약만 인쇄", exact: true }).isDisabled(), false);
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".daily-products-report").isVisible(), false);
    assert.equal(await page.locator(".integrated-daily-detail-print-not-ready").isVisible(), true);
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: "요약만 인쇄", exact: true }).click();
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".integrated-daily-report").isVisible(), true);
    assert.equal(await page.locator(".daily-products-report").isVisible(), false);
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  }
  events.checks.push("missing activity metadata and empty output targets block detail/combined print and Excel while retaining summary print");

  const denseCount = 134;
  await refreshFixture({ revision: "density-allactive", count: denseCount, density: true });
  assert.equal(await page.locator(".daily-products-table tbody tr[data-product-key]").count(), denseCount + 1);
  const denseSummary = await page.locator(".integrated-daily-report").innerHTML();
  await printedProducts(Array.from({ length: denseCount }, (_, i) => i + 1));
  await page.getByRole("button", { name: "상세표만 인쇄", exact: true }).click();
  await savePortraitPdf("portrait134-allactive.pdf");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  assert.equal(await page.locator(".integrated-daily-report").innerHTML(), denseSummary);
  await page.getByRole("button", { name: "요약만 인쇄", exact: true }).click();
  await savePortraitPdf("summary134.pdf");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

  await refreshFixture({ revision: "density-mixed", count: denseCount, density: true, inactiveEvery: 7 });
  const denseIncluded = Array.from({ length: denseCount }, (_, i) => i).filter(i => i % 7 !== 1).map(i => i + 1);
  await printedProducts(denseIncluded);
  assert.equal(await page.locator(".daily-products-table tbody tr[data-product-key]").count(), denseCount + 1, "Mixed inactivity never deletes screen financial rows");
  await page.getByRole("button", { name: "상세표만 인쇄", exact: true }).click();
  await savePortraitPdf("portrait134-mixed.pdf");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  events.checks.push(`134-product portrait fixture: all 134 active rows and ${denseIncluded.length} mixed-activity rows printed, with long names, large amounts and negative profits`);
  assert.equal(events.unexpectedApi.length, 0);
  assert.equal(events.externalBlocked.length, 0);
  assert.equal(events.pageErrors.length, 0);
  assert.ok(events.api.every(request => request.method === "GET"));
  await writeFile(path.join(output, "browser-result.json"), JSON.stringify({ result: "PASS", synthetic: true, products: [3, denseCount], origin, ...events }, null, 2));
  console.log(JSON.stringify({ result: "PASS", checks: events.checks.length, workers: events.workers.length, apiReads: events.api.length, output }));
} catch (error) {
  await writeFile(path.join(output, "browser-result.json"), JSON.stringify({ result: "FAIL", synthetic: true, error: String(error), ...events }, null, 2));
  throw error;
} finally {
  for (const pending of waiting) pending.resolve();
  await browser.close();
}
