// Independent integer-microwon ledger oracle. Synthetic input only; no DB or provider calls.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PLATFORMS, type AdMedium, type Marketplace, type Platform, type SourceCoverage } from "../apps/api/src/unified-performance/types";
import type { PublishedReportFact } from "../apps/api/src/unified-performance/report-contract";
import { summarizeReport, reportBuckets } from "../apps/api/src/unified-performance/domain/report-calculation";

const started = performance.now();
const fixed = (n: bigint) => `${n < 0n ? "-" : ""}${(n < 0n ? -n : n) / 1000000n}.${((n < 0n ? -n : n) % 1000000n).toString().padStart(6, "0")}`;
const parse = (v: string) => BigInt(v.replace(".", ""));
const quality = { isEstimate: false, confidence: "SOURCE_REPORTED" as const, issues: [] as string[] };
const ledger: PublishedReportFact[] = [], coverage: SourceCoverage[] = [];
const end = "2026-10-26";
const dateAt = (offset: number) => new Date(Date.parse(end) - offset * 86400000).toISOString().slice(0, 10);
const salePlatforms: Platform[] = ["NAVER", "COUPANG", "CAFE24"];
const media: Partial<Record<Platform, AdMedium>> = { META: "META", GOOGLE: "GOOGLE", NAVER: "NAVER_DA", COUPANG: "COUPANG_ADS" };
const marketplaces: Partial<Record<Platform, Marketplace>> = { NAVER: "NAVER_SMARTSTORE", COUPANG: "COUPANG", CAFE24: "CAFE24" };
for (let d = 0; d < 366; d++) for (let p = 0; p < PLATFORMS.length; p++) for (let a = 0; a < 2; a++) {
  const platform = PLATFORMS[p], date = dateAt(d), scopeKey = `account-${a}`;
  const sale = salePlatforms.includes(platform), ads = platform !== "CAFE24";
  const ownQuality = platform === "NAVER" ? { ...quality, isEstimate: true, confidence: "ESTIMATED" as const, issues: ["NAVER_STORED_FINGERPRINT_MISSING"] } : quality;
  const components: SourceCoverage["component"][] = [...(sale ? ["SALE", "DIRECT_COST", "COMMON_EXPENSE"] as const : []), ...(ads ? ["AD_SPEND"] as const : [])];
  for (const component of components) coverage.push({ platform, sourceSystem: platform, scopeKey, date, component,
    participation: "INCLUDED", collectionState: "COMPLETE", rowsPresent: 1, zeroConfirmed: false,
    selectedSource: "SYNTHETIC", selectedUploadId: null, sourceVersion: "1", sourceAsOf: "2026-10-27T00:00:00Z",
    collectedAt: "2026-10-27T00:00:00Z", calculatedAt: "2026-10-27T00:00:00Z", lastSuccessAt: "2026-10-27T00:00:00Z",
    sourceFingerprint: "synthetic", nameRuleVersion: "1", costRuleVersion: "1", mappedRows: 1, unmappedRows: 0,
    unmatchedAmount: "0", missingCostRows: 0, missingFxAmount: "0", unallocatedAmount: "0", quality: ownQuality });
  const push = (component: PublishedReportFact["component"], productName: string | null, amount: bigint, before: bigint | null, unit: string | null) => ledger.push({
    platform, scopeKey, date, component, factKey: `${platform}/${scopeKey}/${date}/${component}/${productName}/${unit}/${ledger.length}`,
    productName, saleUnitName: unit, amountKrw: fixed(amount), completeAmountKrw: fixed(amount), profitBeforeAds: before === null ? null : fixed(before),
    completeProfitBeforeAds: before === null ? null : fixed(before), originalAmount: fixed(amount), currency: "KRW", quantity: "1.000000",
    attribution: productName === null ? "UNALLOCATED" : "DIRECT", medium: component === "AD_SPEND" ? media[platform] ?? null : null,
    marketplace: component === "SALE" ? marketplaces[platform] ?? null : null,
    commonKind: component === "COMMON_EXPENSE" ? "OTHER" : component === "SHIPPING_INCOME" ? "SHIPPING_INCOME" : null,
    rowsCount: 1, quality: ownQuality });
  // Vary date/account/product/unit; preserve signed return corrections and sub-won residuals.
  for (let product = 0; product < 2; product++) for (let unit = 0; unit < 2; unit++) {
    const amount = BigInt((d + 1) * (a + 1) * (p + 1) * (product + 1) * (unit + 1)) * 1000000n + 13n;
    const signed = d % 17 === 0 ? -amount : amount;
    if (sale) push("SALE", product ? "B" : "A", signed * 7n, signed * 4n, unit ? "세트" : "단품");
    if (ads) push("AD_SPEND", product ? "B" : "A", amount / 3n, null, null);
  }
  if (sale) { push("COMMON_EXPENSE", null, 1000001n, null, null); push("SHIPPING_INCOME", null, 300001n, null, null); }
}
let cases = 0;
assert.equal(new Set(ledger.map(f => f.factKey)).size, ledger.length, "synthetic ledger keys are unique");
const periods: object[] = [];
let peakRss = process.memoryUsage().rss;
for (const days of [1, 7, 30, 366]) {
  const from = dateAt(days - 1), fs = ledger.filter(f => f.date >= from), cs = coverage.filter(c => c.date >= from);
  const timings: number[] = [];
  for (let mask = 0; mask < 32; mask++) {
    const platforms = PLATFORMS.filter((_, index) => mask & (1 << index));
    for (const scope of [undefined, "account-0"] as const) for (const productName of [undefined, "A", "B"] as const) {
      const scopedFacts = fs.filter(f => scope === undefined || f.scopeKey === scope), scopedCoverage = cs.filter(c => scope === undefined || c.scopeKey === scope);
      const beforeCalculation = performance.now();
      const result = summarizeReport(scopedFacts, scopedCoverage, { platforms, productName });
      timings.push(performance.now() - beforeCalculation);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const selected = scopedFacts.filter(f => platforms.includes(f.platform) && (productName === undefined || f.productName === productName));
      const allSelected = scopedFacts.filter(f => platforms.includes(f.platform));
      const sum = (component: string, field: "amountKrw" | "profitBeforeAds" = "amountKrw", facts = selected) => facts.filter(f => f.component === component).reduce((s, f) => s + parse(f[field]!), 0n);
      const hasSale = platforms.some(p => salePlatforms.includes(p)), hasAds = platforms.some(p => p !== "CAFE24");
      const revenue = hasSale ? fixed(sum("SALE")) : null, adSpend = hasAds ? fixed(sum("AD_SPEND")) : null;
      const before = hasSale ? fixed(sum("SALE", "profitBeforeAds")) : null;
      const profit = hasSale ? fixed(sum("SALE", "profitBeforeAds") - sum("AD_SPEND") - sum("COMMON_EXPENSE") + sum("SHIPPING_INCOME")) : null;
      const label = `${days}/${mask}/${scope ?? "all-accounts"}/${productName ?? "all-products"}`;
      assert.equal(result.knownTotals.revenue, revenue, label + "/revenue"); assert.equal(result.completeTotals.revenue, revenue, label + "/completeRevenue");
      assert.equal(result.knownTotals.adSpend, adSpend, label + "/ads"); assert.equal(result.knownTotals.profitBeforeAds, before, label + "/directCosts");
      assert.equal(result.knownTotals.estimatedProfit, profit, label + "/knownProfit");
      assert.equal(result.completeTotals.estimatedProfit, productName && hasSale ? null : profit, label + "/unallocatedCostBlocksProductProfit");
      const unallocated = sum("COMMON_EXPENSE", "amountKrw", allSelected), income = sum("SHIPPING_INCOME", "amountKrw", allSelected);
      assert.equal(result.scopeBalances.unallocatedExpense, hasSale ? fixed(unallocated) : null, label + "/unallocated");
      assert.equal(result.scopeBalances.unallocatedShippingIncome, hasSale ? fixed(income) : null, label + "/shipping");
      if (hasSale) assert.equal(parse(result.productProfitSubtotal!) - unallocated + income, sum("SALE", "profitBeforeAds") - sum("AD_SPEND") - unallocated + income, label + "/balance");
      assert.equal(result.isEstimate, platforms.includes("NAVER"), label + "/estimate");
      cases++;
    }
  }
  for (const grain of ["day", "week", "month"] as const) {
    const buckets = reportBuckets(from, end, grain);
    assert.equal(buckets.reduce((n, b) => n + b.dayCount, 0), days);
    const represented = buckets.flatMap(b => Array.from({ length: b.dayCount }, (_, i) => new Date(Date.parse(b.bucketFrom) + i * 86400000).toISOString().slice(0, 10)));
    assert.equal(new Set(represented).size, days); assert.equal(represented[0], from); assert.equal(represented.at(-1), end);
  }
  timings.sort((a,b) => a - b);
  periods.push({ days, from, to: end, facts: fs.length, coverage: cs.length, selections: 32, accounts: 2, products: 2, saleUnits: 2, cases: 192,
    calculationP95Ms: Math.round(timings[Math.ceil(timings.length * .95) - 1] * 100) / 100, calculationMaxMs: Math.round(timings.at(-1)! * 100) / 100 });
}
const result = { stage: 10, status: "PASS", databaseAccess: false, providerCalls: 0, remoteWrites: 0, sourceData: "synthetic integer-microwon ledger", periods, cases,
  elapsedMs: Math.round(performance.now() - started), peakSampledRssBytes: peakRss, performanceScope: "In-process read-side calculation only, no database read/publication/worker or network; mixed platform/product/account scopes; full matrix time includes independent oracle assertions",
  checks: ["Independent BigInt sums; no shared Decimal summation in expected values", "Signed returns and six-decimal amounts", "Product direct profit and unallocated common/shipping balance", "Naver estimate acceptance", "Empty/ad-only/sale-only and all platform combinations", "Day/week/month calendar coverage conservation"] };
writeFileSync("docs/product-performance/research/10-calculation-matrix.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
