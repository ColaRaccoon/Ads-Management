import { createHash } from "node:crypto";
import type { UnifiedRule } from "@prisma/client";
import type { AdapterBatch, AdapterRequest, ComponentKind, Platform, Quality, SourceCoverage } from "../types";
import type { PublishedReportFact, ReportFact, ReportSummary, ReportTotals } from "../report-contract";
import { ExactDecimal as D, money, quantizeMoney } from "./decimal";
import { normalizePlatforms, platformSelection } from "./platform-selection";
import { allocateReportAmount } from "./report-allocation";

const uniq = (values: readonly string[]) => [...new Set(values)].sort();
const sum = (values: readonly (string | null)[], empty: string | null = null) => {
  const known = values.filter((value): value is string => value !== null);
  return known.length ? quantizeMoney(known.reduce((total, value) => total.plus(money(value)), new D(0))) : empty;
};
const allSum = (values: readonly (string | null)[], empty: string | null = null) => values.some(value => value === null) ? null : sum(values, empty);
const quality = (values: readonly Quality[]): Quality => ({ isEstimate: values.some(value => value.isEstimate),
  confidence: values.some(value => value.confidence === "ESTIMATED") ? "ESTIMATED" : "SOURCE_REPORTED", issues: uniq(values.flatMap(value => value.issues)) });
const safeIssue = (value: string) => /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(value);
const cleanQuality = (value: Quality): Quality => ({ ...value, issues: value.issues.filter(safeIssue) });

/** Aggregate each independent measure first. This never joins sale rows with ad rows. */
export function prepareReportBatch(request: AdapterRequest, batch: AdapterBatch, rules: readonly UnifiedRule[] = []): ReportFact[] {
  if (request.from !== request.to) throw new Error("REPORT_PREPARATION_REQUIRES_ONE_DAY");
  const rows: ReportFact[] = [];
  const base = (value: Partial<ReportFact>): ReportFact => ({ component: "SALE", factKey: "", productName: null, saleUnitName: null,
    amountKrw: null, completeAmountKrw: null, profitBeforeAds: null, completeProfitBeforeAds: null,
    originalAmount: null, currency: "KRW", quantity: null, attribution: "UNALLOCATED", medium: null, marketplace: null,
    commonKind: null, rowsCount: 1, quality: { isEstimate: false, confidence: "SOURCE_REPORTED", issues: [] }, ...value });
  for (const sale of batch.sales) rows.push(base({ productName: sale.productName, saleUnitName: sale.saleUnitName,
    amountKrw: sale.operatingRevenue, completeAmountKrw: sale.operatingRevenue, profitBeforeAds: sale.profitBeforeAds,
    completeProfitBeforeAds: sale.profitBeforeAds, originalAmount: sale.operatingRevenue,
    quantity: sale.calculationQuantity, attribution: sale.productName ? "DIRECT" : "UNALLOCATED", marketplace: sale.marketplace, quality: cleanQuality(sale.quality) }));
  for (const ad of batch.adSpends) {
    const allocations = allocateReportAmount(request, batch, rules, { component: "AD_SPEND", name: ad.name.originalName,
      productName: ad.productName, amount: ad.amountKrw, attribution: ad.attribution, quality: cleanQuality(ad.quality) });
    // Original-currency amounts use the same exact source weights and preserve their own total.
    const original = allocations.length === 1 ? [{ productName: allocations[0].productName, amount: ad.originalAmount }] :
      allocateReportAmount(request, batch, rules, { component: "AD_SPEND", name: ad.name.originalName,
        productName: ad.productName, amount: ad.originalAmount, attribution: ad.attribution, quality: cleanQuality(ad.quality) });
    for (const target of allocations) rows.push(base({ component: "AD_SPEND", productName: target.productName,
      amountKrw: target.amount, completeAmountKrw: target.amount, originalAmount: original.find(row => row.productName === target.productName)?.amount ?? null,
      currency: ad.currency, attribution: target.attribution, medium: ad.medium, quality: target.quality }));
  }
  for (const expense of batch.commonExpenses) for (const target of allocateReportAmount(request, batch, rules,
    { component: expense.kind, name: expense.kind, productName: expense.productName, amount: expense.amountKrw,
      attribution: expense.allocationStatus, quality: cleanQuality(expense.quality) }))
    rows.push(base({ component: expense.kind === "SHIPPING_INCOME" ? "SHIPPING_INCOME" : "COMMON_EXPENSE", productName: target.productName,
      amountKrw: target.amount, completeAmountKrw: target.amount, originalAmount: target.amount,
      attribution: target.attribution, commonKind: expense.kind, quality: target.quality }));

  const groups = new Map<string, ReportFact[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.component, row.productName, row.saleUnitName, row.attribution, row.medium, row.marketplace, row.commonKind, row.currency]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, values]) => ({ ...values[0],
    factKey: createHash("sha256").update(key).digest("hex"), amountKrw: sum(values.map(value => value.amountKrw)),
    completeAmountKrw: allSum(values.map(value => value.completeAmountKrw)), profitBeforeAds: sum(values.map(value => value.profitBeforeAds)),
    completeProfitBeforeAds: allSum(values.map(value => value.completeProfitBeforeAds)), originalAmount: sum(values.map(value => value.originalAmount)),
    quantity: sum(values.map(value => value.quantity)), rowsCount: values.reduce((count, row) => count + row.rowsCount, 0), quality: quality(values.map(value => value.quality)) }));
}

const sourceFailure = (issues: readonly string[]) => issues.some(issue => /(?:READ_FAILED|NORMALIZATION_FAILED|SOURCE_SELECTION_REQUIRED|WITHHELD|NAVER_AD_AMOUNT_INVALID|NAVER_FAKE_PURCHASE_AMOUNT_INVALID|NAVER_DELIVERY_(?:COMPONENTS|COST|INCOME)_MISSING|NAVER_DELIVERY_AMOUNT_INVALID|PUBLISH_FAILED|SOURCE_READ_FAILED|FAILED_REBUILD)/.test(issue));
/** Collection confidence and numeric computability are separate for accepted Naver estimates. */
export function numericallyAvailableCoverage(row: SourceCoverage): boolean {
  if (row.participation === "NOT_APPLICABLE") return true;
  if (row.participation !== "INCLUDED" || row.collectionState === "NOT_COLLECTED" || sourceFailure(row.quality.issues)) return false;
  if (row.collectionState === "COMPLETE") return row.rowsPresent > 0 || row.zeroConfirmed;
  if (row.platform === "NAVER" && row.rowsPresent > 0) return true;
  // A failed refresh keeps an older, numerically complete revision usable with STALE metadata.
  return row.collectionState === "STALE" && row.rowsPresent > 0 && row.lastSuccessAt !== null;
}

interface MetricResult { known: string | null; complete: string | null }
function metric(rows: readonly PublishedReportFact[], coverage: readonly SourceCoverage[], components: readonly ComponentKind[],
  value: (row: PublishedReportFact) => string | null, completeValue: (row: PublishedReportFact) => string | null, requireCost = false): MetricResult {
  const relevant = coverage.filter(row => components.includes(row.component) && row.participation === "INCLUDED");
  const applicable = relevant.length > 0;
  const metricAvailable = (row: SourceCoverage) => numericallyAvailableCoverage(row) || requireCost && row.component === "DIRECT_COST" &&
    row.collectionState !== "NOT_COLLECTED" && !sourceFailure(row.quality.issues) &&
    relevant.some(sale => sale.component === "SALE" && sale.platform === row.platform && sale.scopeKey === row.scopeKey && sale.date === row.date && numericallyAvailableCoverage(sale));
  const available = relevant.filter(metricAvailable);
  // An absent product in a successfully collected source is a confirmed product zero.
  const known = sum(rows.map(value), !rows.length && available.length ? "0.000000" : null);
  const complete = applicable && relevant.every(metricAvailable) &&
    (!requireCost || rows.every(row => row.completeProfitBeforeAds !== null)) ? allSum(rows.map(completeValue), "0.000000") : null;
  return { known, complete };
}
const nullableDifference = (a: string | null, b: string | null) => a === null || b === null ? null : quantizeMoney(money(a).minus(money(b)));
const ratio = (numerator: string | null, denominator: string | null, multiply = "1") => numerator === null || denominator === null || money(denominator).lte(0)
  ? null : new D(numerator).div(denominator).mul(multiply).toDecimalPlaces(10, D.ROUND_HALF_UP).toFixed(10);
const subtotal = (before: string | null, ads: string | null, common: string | null, income: string | null) =>
  before === null ? null : quantizeMoney(money(before).minus(ads ?? "0").minus(common ?? "0").plus(income ?? "0"));

/** Input coverage must include expected source/day gaps synthesized from the authorized scope policy. */
export function summarizeReport(facts: readonly PublishedReportFact[], coverage: readonly SourceCoverage[],
  options: { platforms: readonly Platform[]; productName?: string }): ReportSummary {
  const platforms = normalizePlatforms(options.platforms), platformAvailability = platformSelection(platforms).metricAvailability;
  const scopeFacts = facts.filter(row => platforms.includes(row.platform));
  const scopedCoverage = coverage.filter(row => platforms.includes(row.platform) && row.participation === "INCLUDED");
  const applicableSale = scopedCoverage.some(row => row.component === "SALE") || scopeFacts.some(row => row.component === "SALE"),
    applicableAd = scopedCoverage.some(row => row.component === "AD_SPEND") || scopeFacts.some(row => row.component === "AD_SPEND");
  const availability = { revenue: platformAvailability.revenue && applicableSale, adSpend: platformAvailability.adSpend && applicableAd,
    profitBeforeAds: platformAvailability.profitBeforeAds && applicableSale, estimatedProfit: platformAvailability.estimatedProfit && applicableSale,
    mer: platformAvailability.mer && applicableSale && applicableAd };
  const selected = scopeFacts.filter(row => options.productName === undefined || row.productName === options.productName);
  const sales = selected.filter(row => row.component === "SALE"), ads = selected.filter(row => row.component === "AD_SPEND"),
    expenses = selected.filter(row => row.component === "COMMON_EXPENSE"), income = selected.filter(row => row.component === "SHIPPING_INCOME");
  const revenue = metric(sales, scopedCoverage, ["SALE"], row => row.amountKrw, row => row.completeAmountKrw);
  const adSpend = metric(ads, scopedCoverage, ["AD_SPEND"], row => row.amountKrw, row => row.completeAmountKrw);
  const before = metric(sales, scopedCoverage, ["SALE", "DIRECT_COST"], row => row.profitBeforeAds, row => row.completeProfitBeforeAds, true);
  const common = metric(expenses, scopedCoverage, ["COMMON_EXPENSE"], row => row.amountKrw, row => row.completeAmountKrw);
  const shipping = metric(income, scopedCoverage, ["COMMON_EXPENSE"], row => row.amountKrw, row => row.completeAmountKrw);
  const unresolvedSales = scopeFacts.filter(row => row.component === "SALE" && row.productName === null &&
    (row.completeAmountKrw === null || !money(row.completeAmountKrw).isZero()));
  const unresolvedAds = scopeFacts.filter(row => row.component === "AD_SPEND" && row.productName === null &&
    (row.completeAmountKrw === null || !money(row.completeAmountKrw).isZero()));
  if (options.productName !== undefined) {
    // Unclassified source amounts may belong to this product. They cannot prove product zero or a complete product amount.
    if (unresolvedSales.length) { revenue.complete = null; before.complete = null; if (!sales.length) { revenue.known = null; before.known = null; } }
    if (unresolvedAds.length) { adSpend.complete = null; if (!ads.length) adSpend.known = null; }
  }
  const relevantCommon = scopedCoverage.some(row => row.component === "COMMON_EXPENSE");
  const unallocatedExpenses = scopeFacts.filter(row => row.component === "COMMON_EXPENSE" || row.component === "SHIPPING_INCOME").filter(row => row.productName === null)
    .map(row => ({ platform: row.platform, scopeKey: row.scopeKey, date: row.date, kind: row.commonKind, amount: row.amountKrw }));
  const unallocatedAdSpends = scopeFacts.filter(row => row.component === "AD_SPEND" && row.productName === null)
    .map(row => ({ platform: row.platform, scopeKey: row.scopeKey, date: row.date, medium: row.medium, amount: row.amountKrw }));
  const unclassifiedSales = scopeFacts.filter(row => row.component === "SALE" && row.productName === null)
    .map(row => ({ platform: row.platform, scopeKey: row.scopeKey, date: row.date, amount: row.amountKrw }));
  const hasUnallocated = [...unallocatedExpenses, ...unallocatedAdSpends].some(row => row.amount === null || !money(row.amount).isZero());
  const completeProfit = before.complete !== null && (!availability.adSpend || adSpend.complete !== null) &&
    (!relevantCommon || common.complete !== null && shipping.complete !== null) && !(options.productName !== undefined && hasUnallocated);
  const knownTotals: ReportTotals = { revenue: availability.revenue ? revenue.known : null,
    adSpend: availability.adSpend ? adSpend.known : null, profitBeforeAds: availability.profitBeforeAds ? before.known : null,
    estimatedProfit: availability.estimatedProfit ? subtotal(before.known, adSpend.known, common.known, shipping.known) : null,
    mer: availability.mer ? ratio(revenue.known, adSpend.known) : null };
  const completeTotals: ReportTotals = { revenue: availability.revenue ? revenue.complete : null,
    adSpend: availability.adSpend ? adSpend.complete : null, profitBeforeAds: availability.profitBeforeAds ? before.complete : null,
    estimatedProfit: availability.estimatedProfit && completeProfit ? subtotal(before.complete, adSpend.complete, common.complete, shipping.complete) : null,
    mer: availability.mer ? ratio(revenue.complete, adSpend.complete) : null };
  const mappedSales = sales.filter(row => row.productName !== null), mappedAds = ads.filter(row => row.productName !== null),
    mappedExpenses = expenses.filter(row => row.productName !== null), mappedIncome = income.filter(row => row.productName !== null);
  const mediumFor: Partial<Record<Platform, string>> = { META: "META", GOOGLE: "GOOGLE", NAVER: "NAVER_DA", COUPANG: "COUPANG_ADS" };
  const marketFor: Partial<Record<Platform, string>> = { CAFE24: "CAFE24", NAVER: "NAVER_SMARTSTORE", COUPANG: "COUPANG" };
  const byMarketplace = uniq([...sales.map(row => row.marketplace!), ...scopedCoverage.filter(row => row.component === "SALE").map(row => marketFor[row.platform]!)].filter(Boolean))
    .map(marketplace => {
      const ownCoverage = scopedCoverage.filter(row => marketFor[row.platform] === marketplace), ownSales = sales.filter(row => row.marketplace === marketplace);
      return { marketplace, revenue: options.productName !== undefined && !ownSales.length && unresolvedSales.some(row => row.marketplace === marketplace) ? null :
        metric(ownSales, ownCoverage, ["SALE"], row => row.amountKrw, row => row.completeAmountKrw).known };
    });
  const byMedium = uniq([...ads.map(row => row.medium!), ...scopedCoverage.filter(row => row.component === "AD_SPEND").map(row => mediumFor[row.platform]!)].filter(Boolean)).map(medium => {
    const ownCoverage = scopedCoverage.filter(row => mediumFor[row.platform] === medium), ownAds = ads.filter(row => row.medium === medium);
    const amount = options.productName !== undefined && !ownAds.length && unresolvedAds.some(row => row.medium === medium) ? null :
      metric(ownAds, ownCoverage, ["AD_SPEND"], row => row.amountKrw, row => row.completeAmountKrw).known;
    return { medium, adSpend: amount, share: ratio(amount, adSpend.known, "100") };
  });
  const issues = uniq([...selected.flatMap(row => row.quality.issues), ...scopedCoverage.flatMap(row => row.quality.issues).filter(safeIssue),
    ...((Object.keys(knownTotals) as Array<keyof ReportTotals>).some(key => knownTotals[key] !== null && completeTotals[key] === null) ? ["PARTIAL_TOTAL"] : []),
    ...(scopedCoverage.some(row => !numericallyAvailableCoverage(row)) ? ["INCOMPLETE_COVERAGE"] : []),
    ...(hasUnallocated ? ["UNALLOCATED_BALANCE"] : []), ...(unclassifiedSales.length ? ["UNCLASSIFIED_SALES"] : []),
    ...(availability.mer && adSpend.known !== null && money(adSpend.known).lte(0) ? ["ZERO_AD_SPEND_BASE"] : [])]);
  const scopeSales = scopeFacts.filter(row => row.component === "SALE"), scopeAds = scopeFacts.filter(row => row.component === "AD_SPEND"),
    scopeExpenses = scopeFacts.filter(row => row.component === "COMMON_EXPENSE"), scopeIncome = scopeFacts.filter(row => row.component === "SHIPPING_INCOME"),
    unmatchedSales = scopeSales.filter(row => row.productName === null), unallocatedIncome = scopeIncome.filter(row => row.productName === null),
    unallocatedCosts = scopeExpenses.filter(row => row.productName === null);
  // Balances describe the selected source ledger even on a product-filtered response; they are not assigned to that product.
  const scopeRevenueKnown = metric(scopeSales, scopedCoverage, ["SALE"], row => row.amountKrw, row => row.completeAmountKrw).known,
    scopeBeforeKnown = metric(scopeSales, scopedCoverage, ["SALE", "DIRECT_COST"], row => row.profitBeforeAds, row => row.completeProfitBeforeAds, true).known,
    scopeAdKnown = metric(scopeAds, scopedCoverage, ["AD_SPEND"], row => row.amountKrw, row => row.completeAmountKrw).known,
    scopeCommonKnown = metric(scopeExpenses, scopedCoverage, ["COMMON_EXPENSE"], row => row.amountKrw, row => row.completeAmountKrw).known,
    scopeShippingKnown = metric(scopeIncome, scopedCoverage, ["COMMON_EXPENSE"], row => row.amountKrw, row => row.completeAmountKrw).known;
  return { knownTotals, completeTotals,
    productProfitSubtotal: availability.estimatedProfit ? subtotal(sum(mappedSales.map(row => row.profitBeforeAds), before.known !== null ? "0.000000" : null),
      sum(mappedAds.map(row => row.amountKrw)), sum(mappedExpenses.map(row => row.amountKrw)), sum(mappedIncome.map(row => row.amountKrw))) : null,
    byMarketplace, byMedium, unallocatedExpenses, unallocatedAdSpends, unclassifiedSales,
    scopeBalances: { unallocatedAdSpend: sum(unallocatedAdSpends.map(row => row.amount), !unallocatedAdSpends.length && scopeAdKnown !== null ? "0.000000" : null),
      unallocatedExpense: sum(unallocatedCosts.map(row => row.amountKrw), !unallocatedCosts.length && scopeCommonKnown !== null ? "0.000000" : null),
      shippingIncome: scopeShippingKnown,
      unallocatedShippingIncome: sum(unallocatedIncome.map(row => row.amountKrw), !unallocatedIncome.length && scopeShippingKnown !== null ? "0.000000" : null),
      unclassifiedRevenue: sum(unmatchedSales.map(row => row.amountKrw), !unmatchedSales.length && scopeRevenueKnown !== null ? "0.000000" : null),
      unclassifiedProfitBeforeAds: sum(unmatchedSales.map(row => row.profitBeforeAds), !unmatchedSales.length && scopeBeforeKnown !== null ? "0.000000" : null) },
    isEstimate: selected.some(row => row.quality.isEstimate) || scopedCoverage.some(row => row.quality.isEstimate), issues };
}

export interface MetricComparison { current: string | null; previous: string | null; change: string | null; changePct: string | null;
  reason: "MISSING_INPUT" | "ZERO_BASE" | "NON_POSITIVE_PROFIT_BASE" | null; currentDailyAverage: string | null; previousDailyAverage: string | null }
export function compareTotals(current: ReportTotals, previous: ReportTotals, currentDays: number, previousDays: number) {
  if (!Number.isInteger(currentDays) || !Number.isInteger(previousDays) || currentDays < 1 || previousDays < 1) throw new Error("INVALID_COMPARISON_DAYS");
  return Object.fromEntries((Object.keys(current) as Array<keyof ReportTotals>).map(key => {
    const now = current[key], before = previous[key], change = now === null || before === null ? null :
      key === "mer" ? new D(now).minus(before).toFixed(10) : nullableDifference(now, before);
    const profit = key === "profitBeforeAds" || key === "estimatedProfit";
    const reason: MetricComparison["reason"] = now === null || before === null ? "MISSING_INPUT" : profit && (new D(before).lte(0) || new D(now).isNegative()) ? "NON_POSITIVE_PROFIT_BASE" : new D(before).isZero() ? "ZERO_BASE" : null;
    const divide = (value: string | null, days: number) => value === null ? null : quantizeMoney(new D(value).div(days));
    const result: MetricComparison = { current: now, previous: before, change, changePct: reason ? null : new D(change!).div(before!).mul(100).toDecimalPlaces(10).toFixed(10),
      reason, currentDailyAverage: key === "mer" ? null : divide(now, currentDays), previousDailyAverage: key === "mer" ? null : divide(before, previousDays) };
    return [key, result];
  })) as Record<keyof ReportTotals, MetricComparison>;
}

/** A product with explicit participation policies uses their union, including date and account bounds. */
export function scopePolicyComponents(rules: readonly UnifiedRule[], productId: string, platform: Platform, scopeKey: string, date: string,
  defaults: readonly ComponentKind[]): ComponentKind[] {
  const policies = rules.filter(rule => rule.kind === "SCOPE_POLICY" && rule.active && rule.productId === productId);
  if (!policies.length) return [...defaults];
  const components = policies.filter(rule => rule.platform === platform && (!rule.scopeKey || rule.scopeKey === scopeKey) &&
    rule.validFrom.toISOString().slice(0, 10) <= date && (!rule.validTo || rule.validTo.toISOString().slice(0, 10) >= date))
    .flatMap(rule => (rule.payload as { components: ComponentKind[] }).components);
  return defaults.filter(component => components.includes(component));
}

/** Ratios are always calculated from bucket totals, never by averaging daily percentages. */
export function compareMedia(current: ReportSummary, previous: ReportSummary) {
  return uniq([...current.byMedium, ...previous.byMedium].map(row => row.medium)).map(medium => {
    const now = current.byMedium.find(row => row.medium === medium), before = previous.byMedium.find(row => row.medium === medium);
    const currentAmount = now?.adSpend ?? (current.completeTotals.adSpend !== null ? "0.000000" : null),
      previousAmount = before?.adSpend ?? (previous.completeTotals.adSpend !== null ? "0.000000" : null);
    const change = nullableDifference(currentAmount, previousAmount);
    const shareNow = ratio(currentAmount, current.knownTotals.adSpend, "100"), shareBefore = ratio(previousAmount, previous.knownTotals.adSpend, "100");
    return { medium, current: currentAmount, previous: previousAmount, change,
      changePct: ratio(change, previousAmount, "100"), share: shareNow, previousShare: shareBefore,
      shareChangePp: shareNow === null || shareBefore === null ? null : new D(shareNow).minus(shareBefore).toFixed(10),
      spendChangeContributionPp: ratio(change, previous.knownTotals.adSpend, "100"),
      reason: currentAmount === null || previousAmount === null ? "MISSING_INPUT" : money(previousAmount).lte(0) ? "ZERO_BASE" : null };
  });
}

export interface ReportBucket { date: string; bucketFrom: string; bucketTo: string; partialPeriod: boolean; dayCount: number }
export function reportBuckets(from: string, to: string, grain: "day" | "week" | "month"): ReportBucket[] {
  const end = Date.parse(`${to}T00:00:00Z`), start = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end - start) / 86400000 > 365) throw new Error("INVALID_REPORT_PERIOD");
  const day = (value: Date | number) => new Date(value).toISOString().slice(0, 10), groups = new Map<string, string[]>();
  for (let at = start; at <= end; at += 86400000) {
    const value = new Date(at), period = new Date(at);
    if (grain === "month") period.setUTCDate(1);
    else if (grain === "week") period.setUTCDate(period.getUTCDate() - (period.getUTCDay() + 6) % 7);
    const key = day(period); groups.set(key, [...(groups.get(key) ?? []), day(value)]);
  }
  return [...groups].map(([date, dates]) => {
    const periodEnd = new Date(`${date}T00:00:00Z`);
    if (grain === "month") { periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1); periodEnd.setUTCDate(0); }
    else if (grain === "week") periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
    return { date, bucketFrom: dates[0], bucketTo: dates[dates.length - 1], partialPeriod: dates[0] !== date || dates[dates.length - 1] !== day(periodEnd), dayCount: dates.length };
  });
}
