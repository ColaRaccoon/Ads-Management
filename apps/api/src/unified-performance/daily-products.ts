import type { ReportSnapshot } from "./report.repository";
import type { ReportQuery } from "./report-query";
import { reportHash } from "./report-query";
import type { PublishedReportFact, ReportSummary } from "./report-contract";
import type { Platform, SourceCoverage } from "./types";
import { summarizeReport } from "./domain/report-calculation";
import { overlayStorefrontResults } from "./domain/storefront-report-overlay";
import { decimal, ExactDecimal } from "./domain/decimal";

export type DailyProductMetrics = Pick<ReportSummary,
  "knownTotals" | "completeTotals" | "byMarketplace" | "byMedium" | "isEstimate"> & {
    notApplicable?: { revenue: Platform[]; adSpend: Platform[] };
    comparisonBasis?: { NAVER?: string };
  };
export type DailyProductScope = { facts: PublishedReportFact[]; coverage: SourceCoverage[] };
type ApplyScope = (snapshot: ReportSnapshot, productName?: string) => DailyProductScope;
export type DailyProductExportPlatform = "STOREFRONT" | "GOOGLE" | "COUPANG" | "NAVER";

function sourceGroup(fact: PublishedReportFact): DailyProductExportPlatform | null {
  if (fact.platform === "CAFE24" && (fact.component === "SALE" || fact.component === "STOREFRONT_RESULT")) {
    if (fact.marketplace === "CAFE24_YOUTUBE") return "GOOGLE";
    if (fact.marketplace === "CAFE24_META" || fact.marketplace === "CAFE24") return "STOREFRONT";
  } else if (fact.component === "AD_SPEND" && fact.platform === "META") return "STOREFRONT";
  else if (fact.component === "AD_SPEND" && fact.platform === "GOOGLE") return "GOOGLE";
  else if (fact.platform === "COUPANG" && (fact.component === "SALE" || fact.component === "AD_SPEND")) return "COUPANG";
  else if (fact.platform === "NAVER" && fact.component === "SALE") return "NAVER";
  return null;
}
function confirmedZero(value: string | null | undefined): boolean {
  try { return decimal(value).isZero(); } catch { return false; }
}
/** Consume canonical spend; unrelated unassigned ads may make its display partial
 * without making this product's fully numeric stored ad rows unknown.
 */
function confirmedZeroAds(group: DailyProductExportPlatform, summary: ReportSummary, scope: DailyProductScope, query: ReportQuery, productName: string): boolean {
  const split = summary.byMarketplace.some(row => row.marketplace === "CAFE24_META" || row.marketplace === "CAFE24_YOUTUBE");
  const legacy = summary.byMarketplace.some(row => row.marketplace === "CAFE24");
  const platforms: Platform[] = group === "STOREFRONT" ? !split && legacy ? ["META", "GOOGLE"] : ["META"] : [group];
  const selected = platforms.filter(platform => query.platforms.includes(platform));
  if (!selected.length) return true;
  const coverage = scope.coverage.filter(row => row.date === query.to && row.component === "AD_SPEND" && selected.includes(row.platform) &&
    (query.scopeKeys === undefined || query.scopeKeys.includes(row.scopeKey)));
  if (coverage.length && coverage.every(row => row.participation === "NOT_APPLICABLE")) return true;
  if (group === "STOREFRONT" && split && legacy) return false;
  const zeroDisplay = (display: { value: string | null; state: string }) => {
    if (!confirmedZero(display.value)) return false;
    if (display.state === "COMPLETE") return true;
    if (display.state !== "PARTIAL") return false;
    const ownAds = scope.facts.filter(fact => fact.productName === productName && fact.date === query.to && fact.component === "AD_SPEND" &&
      fact.rowsCount > 0 && selected.includes(fact.platform) && (query.scopeKeys === undefined || query.scopeKeys.includes(fact.scopeKey)));
    return ownAds.length > 0 && ownAds.every(fact => {
      try { return decimal(fact.amountKrw).isFinite() && decimal(fact.completeAmountKrw).isFinite(); } catch { return false; }
    });
  };
  const marketplace = group === "STOREFRONT" ? !split && legacy ? "CAFE24" : "CAFE24_META" :
    group === "GOOGLE" ? "CAFE24_YOUTUBE" : group === "NAVER" ? "NAVER_SMARTSTORE" : "COUPANG";
  const market = summary.byMarketplace.find(row => row.marketplace === marketplace);
  if (market?.display?.adSpend) return zeroDisplay(market.display.adSpend);
  if (market?.adSpend != null) return confirmedZero(market.adSpend);
  const medium = group === "STOREFRONT" ? "META" : group === "COUPANG" ? "COUPANG_ADS" : group === "NAVER" ? "NAVER_DA" : "GOOGLE";
  const media = summary.byMedium.find(row => row.medium === medium);
  if (media?.displayAdSpend) return zeroDisplay(media.displayAdSpend);
  return confirmedZero(media?.completeAdSpend);
}
/** Only current-day source products qualify. Drop a group solely when both its
 * stored sale quantity and canonical ad spend are confirmed zero. No monetary
 * calculation is repeated, and missing quantities never become invented zeroes.
 */
function exportPlatforms(scope: DailyProductScope, query: ReportQuery, productName: string, summary: ReportSummary): DailyProductExportPlatform[] {
  if (process.env.UNIFIED_NATIVE_RESULTS_READ_ENABLED === "true") {
    const active = new Set<DailyProductExportPlatform>();
    for (const fact of scope.facts) {
      const row = fact.nativeResult;
      if (fact.component !== "NATIVE_RESULT" || !row || row.kind !== "PRODUCT" || fact.productName !== productName ||
        fact.date !== query.to || !query.platforms.includes(fact.platform) ||
        (query.scopeKeys !== undefined && !query.scopeKeys.includes(fact.scopeKey))) continue;
      // Quantity and spend belong to this exact native product result. Unrelated
      // source coverage warnings never turn a numeric product zero into activity.
      if (!confirmedZero(row.quantity) || !confirmedZero(row.adSpend.known)) active.add(row.group);
    }
    return (["STOREFRONT", "GOOGLE", "COUPANG", "NAVER"] as const).filter(group => active.has(group));
  }
  const present = new Map<DailyProductExportPlatform, { quantity: InstanceType<typeof ExactDecimal>; unknown: boolean }>();
  for (const fact of scope.facts) {
    if (fact.productName !== productName || fact.rowsCount <= 0 || fact.saleUnitName === "PARTITION_MARKER" ||
      fact.date !== query.to || !query.platforms.includes(fact.platform) ||
      (query.scopeKeys !== undefined && !query.scopeKeys.includes(fact.scopeKey)) || fact.attribution !== "DIRECT") continue;
    const group = sourceGroup(fact);
    if (!group) continue;
    const state = present.get(group) ?? { quantity: new ExactDecimal(0), unknown: false };
    if (fact.component === "SALE" || fact.component === "STOREFRONT_RESULT") {
      try { state.quantity = state.quantity.plus(decimal(fact.quantity)); } catch { state.unknown = true; }
      // Source-wide collection/cost warnings do not invalidate a stored quantity.
      if (fact.quality.issues.some(issue => /QUANTITY/.test(issue) && /UNAVAILABLE|UNKNOWN|MISSING|INVALID|UNRESOLVED/.test(issue))) state.unknown = true;
    }
    present.set(group, state);
  }
  return (["STOREFRONT", "GOOGLE", "COUPANG", "NAVER"] as const).filter(group => {
    const state = present.get(group);
    return state !== undefined && (state.unknown || !state.quantity.isZero() || !confirmedZeroAds(group, summary, scope, query, productName));
  });
}

function metrics(summary: ReportSummary, coverage: SourceCoverage[], day: string): DailyProductMetrics {
  const { knownTotals, completeTotals, byMarketplace, byMedium, isEstimate } = summary;
  const participation = new Map<string, { platform: Platform; component: string; allNotApplicable: boolean }>();
  for (const row of coverage) {
    if (row.date !== day || (row.component !== "SALE" && row.component !== "AD_SPEND")) continue;
    const key = `${row.platform}:${row.component}`, prior = participation.get(key);
    participation.set(key, { platform: row.platform, component: row.component,
      allNotApplicable: (prior?.allNotApplicable ?? true) && row.participation === "NOT_APPLICABLE" });
  }
  // Absence is unknown. Only explicit, unanimous non-participation in every
  // selected account can become "not applicable" instead of "data missing".
  const excluded = [...participation.values()].filter(row => row.allNotApplicable);
  const notApplicable = { revenue: excluded.filter(row => row.component === "SALE").map(row => row.platform).sort(),
    adSpend: excluded.filter(row => row.component === "AD_SPEND").map(row => row.platform).sort() };
  // Preserve amounts; identify a source-basis change for the presentation layer.
  // Daily revisions, amounts and timestamps normally change and are not the basis.
  const naverBases = [...new Set(coverage.filter(row => row.date === day && row.platform === "NAVER" &&
    row.participation === "INCLUDED" && row.collectionState !== "NOT_COLLECTED" && row.sourceVersion)
    .map(row => JSON.stringify([row.scopeKey, row.selectedSource === "NAVER_STORED_PROFIT_V2" ||
      row.quality.issues.includes("NAVER_STORED_NATIVE_SOURCE") ? "STORED_NATIVE" : "LEGACY"])))].sort();
  const comparisonBasis = naverBases.length ? { NAVER: reportHash(naverBases) } : {};
  return { knownTotals, completeTotals, byMarketplace, byMedium, isEstimate, notApplicable, comparisonBasis };
}

/**
 * Assemble two published days using the existing canonical read calculation.
 * No source reads, rebuilds, cost/allocation formulas or mutable state live here.
 * Index the fact ledger once; per-product reads retain unassigned facts and native
 * partition context because both affect completeness even on a product response.
 */
export function buildDailyProducts(snapshot: ReportSnapshot, query: ReportQuery, applyScope: ApplyScope,
  precomputedDays?: { current: ReportSummary; previous: ReportSummary }) {
  const facts = overlayStorefrontResults(snapshot.facts);
  const byProduct = new Map<string, PublishedReportFact[]>();
  const shared: PublishedReportFact[] = [];
  const nativeContext = new Map<string, PublishedReportFact>();
  for (const fact of facts) {
    if (fact.productName === null) shared.push(fact);
    else {
      const rows = byProduct.get(fact.productName);
      if (rows) rows.push(fact); else byProduct.set(fact.productName, [fact]);
    }
    // Older ready partitions may have channel results without zero-row markers.
    // Retain a real row as context; productName filtering still excludes its money.
    if (fact.component === "SALE" && ["CAFE24_META", "CAFE24_YOUTUBE"].includes(fact.marketplace ?? "")) {
      const key = JSON.stringify([fact.platform, fact.scopeKey, fact.date, fact.marketplace]);
      if (!nativeContext.has(key)) nativeContext.set(key, fact);
    }
  }
  const catalog = new Map(snapshot.products.map(product => [product.canonicalName, product]));
  const rules = new Map<string, ReportSnapshot["rules"]>();
  for (const rule of snapshot.rules) {
    if (rule.productId === null) continue;
    const rows = rules.get(rule.productId);
    if (rows) rows.push(rule); else rules.set(rule.productId, [rule]);
  }
  const names = [...new Set([...catalog.keys(), ...(snapshot.availableProductNames ?? []), ...byProduct.keys()])].sort();
  const context = [...shared, ...nativeContext.values()];
  const summarizeDay = (scope: DailyProductScope, day: string, productName?: string) => summarizeReport(
    scope.facts.filter(fact => fact.date === day), scope.coverage.filter(row => row.date === day),
    { platforms: query.platforms, productName });
  const products = names.map(productName => {
    const product = catalog.get(productName);
    // No full-ledger filter or catalog/rule scan for every product. The same real
    // context row may also be the selected product's row, so de-duplicate by identity.
    const productFacts = [...new Set([...(byProduct.get(productName) ?? []), ...context])];
    const scope = applyScope({ ...snapshot, facts: productFacts, products: product ? [product] : [],
      rules: product ? rules.get(product.id) ?? [] : [] }, productName);
    const currentSummary = summarizeDay(scope, query.to, productName);
    return { productKey: product ? `product:${product.id}` : `historical:${productName}`, productName,
      active: product?.active ?? false, historical: !product,
      exportPlatforms: exportPlatforms(scope, query, productName, currentSummary),
      current: metrics(currentSummary, scope.coverage, query.to),
      previous: metrics(summarizeDay(scope, query.from, productName), scope.coverage, query.from) };
  });
  const allScope = precomputedDays ? { facts, coverage: snapshot.coverage } : applyScope({ ...snapshot, facts });
  const withBalances = (summary: ReportSummary, day: string) => ({ ...metrics(summary, allScope.coverage, day), scopeBalances: summary.scopeBalances });
  return { products, totalProducts: products.length, nextCursor: null, exportActivityVersion: 3 as const,
    reportDate: query.to, previousDate: query.from,
    allProducts: { current: withBalances(precomputedDays?.current ?? summarizeDay(allScope, query.to), query.to),
      previous: withBalances(precomputedDays?.previous ?? summarizeDay(allScope, query.from), query.from) } };
}
