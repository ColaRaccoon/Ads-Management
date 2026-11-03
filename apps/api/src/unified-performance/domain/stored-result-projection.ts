import { createHash } from "node:crypto";
import type { NativeResultAmount, NativeResultGroup, NativeStoredResult } from "../native-result-contract";
import type { DisplayAmount, PublishedReportFact, ReportFact, ReportSummary, ReportTotals } from "../report-contract";
import type { Platform, SourceCoverage } from "../types";
import { ExactDecimal as D, decimal, money, quantizeMoney } from "./decimal";

const groups = ["STOREFRONT", "GOOGLE", "NAVER", "COUPANG"] as const;
const market: Record<NativeResultGroup, string> = { STOREFRONT: "CAFE24_META", GOOGLE: "CAFE24_YOUTUBE", NAVER: "NAVER_SMARTSTORE", COUPANG: "COUPANG" };
const owner: Record<NativeResultGroup, Platform> = { STOREFRONT: "CAFE24", GOOGLE: "CAFE24", NAVER: "NAVER", COUPANG: "COUPANG" };
const medium: Record<NativeResultGroup, string> = { STOREFRONT: "META", GOOGLE: "GOOGLE", NAVER: "NAVER_DA", COUPANG: "COUPANG_ADS" };
const zero: NativeResultAmount = { known: "0.000000", complete: "0.000000" };
const missing: NativeResultAmount = { known: null, complete: null };
const sum = (values: readonly (string | null)[]) => {
  const known = values.filter((v): v is string => v !== null);
  return known.length ? quantizeMoney(known.reduce((n, v) => n.plus(decimal(v)), new D(0))) : null;
};
const add = (values: readonly NativeResultAmount[]): NativeResultAmount => ({ known: sum(values.map(v => v.known)),
  complete: values.length && values.every(v => v.complete !== null) ? sum(values.map(v => v.complete)) : null });
const ratio = (a: string | null, b: string | null, multiplier = 1) => a !== null && b !== null && money(b).gt(0)
  ? money(a).div(money(b)).mul(multiplier).toFixed(10) : null;
const display = (value: NativeResultAmount, platform: Platform): DisplayAmount => ({ value: value.complete ?? value.known,
  state: value.complete !== null ? "COMPLETE" : value.known !== null ? "PARTIAL" : "UNAVAILABLE",
  availableSources: value.known !== null ? [platform] : [], missingSources: value.complete === null ? [platform] : [] });

/** Serialization only. Native final amounts are copied byte-for-byte and independently validated at publication. */
export function prepareNativeResultFacts(rows: readonly NativeStoredResult[]): ReportFact[] {
  const column = (value: string | null) => value === null ? null : quantizeMoney(decimal(value));
  return rows.map(row => ({ component: "NATIVE_RESULT", nativeResult: row,
    factKey: createHash("sha256").update(JSON.stringify([row.group, row.kind, row.productKey])).digest("hex"),
    productName: row.kind === "SUMMARY" ? null : row.productName, saleUnitName: row.kind === "SUMMARY" ? "NATIVE_SUMMARY" : row.productKey,
    amountKrw: column(row.revenue.known), completeAmountKrw: column(row.revenue.complete),
    profitBeforeAds: column(row.profitBeforeAds.known), completeProfitBeforeAds: column(row.profitBeforeAds.complete),
    originalAmount: null, currency: "KRW", quantity: row.quantity, attribution: row.productName ? "DIRECT" : "UNALLOCATED",
    medium: medium[row.group], marketplace: market[row.group], commonKind: null, rowsCount: row.kind === "SUMMARY" ? 0 : 1,
    quality: { isEstimate: row.issues.length > 0, confidence: "SOURCE_REPORTED", issues: row.issues } }));
}

/** A report GET can sum stored money and form ratios. It cannot subtract ads/costs/VAT from a native final profit. */
export function summarizeNativeResults(facts: readonly PublishedReportFact[], coverage: readonly SourceCoverage[],
  options: { platforms: readonly Platform[]; productName?: string; omitMarketplaceMetrics?: boolean }): ReportSummary {
  const native = facts.filter(f => f.component === "NATIVE_RESULT" && f.nativeResult && options.platforms.includes(f.platform));
  const selectedGroups = groups.filter(g => options.platforms.includes(owner[g]));
  const metrics = ["revenue", "adSpend", "netProfit", "profitBeforeAds"] as const;
  const result = selectedGroups.map(group => {
    const groupRows = native.filter(f => f.nativeResult!.group === group);
    // The original sole-shop calculator already includes authorized old CSV
    // inputs. Its explicit ownership metadata supersedes the unbound audit
    // partition; this is source selection, never deduplication of money.
    const coveredDates = new Set(groupRows.filter(f => f.nativeResult!.kind === "SUMMARY" && f.scopeKey !== "LEGACY_UNBOUND" &&
      f.nativeResult!.audit?.scopeOwnership === "SOLE_STOREFRONT" && f.nativeResult!.audit?.coveredLegacyScope === "LEGACY_UNBOUND").map(f => f.date));
    const own = groupRows.filter(f => f.scopeKey !== "LEGACY_UNBOUND" || !coveredDates.has(f.date));
    const summaries = own.filter(f => f.nativeResult!.kind === "SUMMARY");
    const keys = new Map(summaries.map(f => [JSON.stringify([f.scopeKey, f.date]), f]));
    const sourceCoverage = coverage.filter(c => c.platform === owner[group] && c.component === "SALE" &&
      (c.scopeKey !== "LEGACY_UNBOUND" || !coveredDates.has(c.date)));
    const notApplicable = sourceCoverage.length > 0 && sourceCoverage.every(c => c.participation === "NOT_APPLICABLE");
    const expected = sourceCoverage.filter(c => c.participation === "INCLUDED");
    const absent = !notApplicable && (expected.some(c => !keys.has(JSON.stringify([c.scopeKey, c.date]))) || !summaries.length);
    const values = Object.fromEntries(metrics.map(metric => {
      const items = options.productName === undefined ? summaries.map(f => f.nativeResult![metric]) : summaries.map(s => {
        const rows = own.filter(f => f.scopeKey === s.scopeKey && f.date === s.date && f.nativeResult!.kind === "PRODUCT" && f.productName === options.productName);
        return rows.length ? add(rows.map(f => f.nativeResult![metric])) : s.nativeResult![metric].complete !== null ? zero : missing;
      });
      const value = add(items);
      return [metric, absent ? { ...value, complete: null } : value];
    })) as Record<typeof metrics[number], NativeResultAmount>;
    return { group, values, absent, notApplicable, rows: own };
  });
  // Advertising-only selections retain the published advertising amount; no profit is invented for them.
  const adOnly = options.platforms.filter(p => (p === "META" || p === "GOOGLE") && !options.platforms.includes("CAFE24")).map(platform => {
    const expected = coverage.filter(c => c.platform === platform && c.component === "AD_SPEND" && c.participation === "INCLUDED");
    const rows = facts.filter(f => f.platform === platform && f.component === "AD_SPEND" && (options.productName === undefined || f.productName === options.productName));
    const values = expected.map(c => {
      const own = rows.filter(f => f.scopeKey === c.scopeKey && f.date === c.date);
      const value = own.length ? add(own.map(f => ({ known: f.amountKrw, complete: f.completeAmountKrw }))) :
        c.collectionState === "COMPLETE" && (c.zeroConfirmed || options.productName !== undefined) ? zero : missing;
      return c.collectionState === "COMPLETE" ? value : { ...value, complete: null };
    });
    const value = expected.length ? add(values) : { known: sum(rows.map(f => f.amountKrw)), complete: null };
    return { platform, value };
  });
  const totals = (complete: boolean): ReportTotals => {
    const value = (key: typeof metrics[number]) => add([...result.filter(r => !r.notApplicable).map(r => r.values[key]), ...(key === "adSpend" ? adOnly.map(r => r.value) : [])])[complete ? "complete" : "known"];
    const revenue = value("revenue"), adSpend = value("adSpend");
    return { revenue, adSpend, estimatedProfit: value("netProfit"), profitBeforeAds: value("profitBeforeAds"), mer: ratio(revenue, adSpend) };
  };
  const knownTotals = totals(false), completeTotals = totals(true);
  const byMedium = [...result.map(r => ({ medium: medium[r.group], adSpend: r.values.adSpend.known,
    completeAdSpend: r.values.adSpend.complete, displayAdSpend: display(r.values.adSpend, r.group === "STOREFRONT" ? "META" : r.group), share: ratio(r.values.adSpend.known, knownTotals.adSpend, 100) })),
    ...adOnly.map(r => ({ medium: r.platform, adSpend: r.value.known, completeAdSpend: r.value.complete, displayAdSpend: display(r.value, r.platform), share: ratio(r.value.known, knownTotals.adSpend, 100) }))];
  const usedNative = result.flatMap(r => r.rows);
  const selectedProducts = usedNative.filter(f => f.nativeResult!.kind === "PRODUCT" && f.productName !== null && (options.productName === undefined || f.productName === options.productName));
  return { knownTotals, completeTotals, productProfitSubtotal: sum(selectedProducts.map(f => f.nativeResult!.netProfit.known)),
    byMarketplace: options.omitMarketplaceMetrics ? [] : result.map(r => ({ marketplace: market[r.group], revenue: r.values.revenue.known,
      completeRevenue: r.values.revenue.complete, adSpend: r.values.adSpend.complete, estimatedProfit: r.values.netProfit.complete,
      profitBeforeAds: r.values.profitBeforeAds.complete,
      display: { revenue: display(r.values.revenue, owner[r.group]), adSpend: display(r.values.adSpend, owner[r.group]), estimatedProfit: display(r.values.netProfit, owner[r.group]) } })),
    byMedium, unallocatedExpenses: [], unallocatedAdSpends: [], unclassifiedSales: [],
    scopeBalances: { unallocatedAdSpend: null, unallocatedExpense: null, shippingIncome: null, unallocatedShippingIncome: null, unclassifiedRevenue: null, unclassifiedProfitBeforeAds: null },
    isEstimate: usedNative.some(f => f.quality.isEstimate), issues: [...new Set(["NATIVE_FINAL_RESULTS", ...usedNative.flatMap(f => f.nativeResult!.issues),
      ...(result.some(r => r.absent) ? ["NATIVE_RESULT_NOT_PUBLISHED"] : [])])] };
}
