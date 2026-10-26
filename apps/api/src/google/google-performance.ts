import { Prisma } from "@prisma/client";
import { Cafe24CouponOrderLineInput, Cafe24CouponRuleInput, resolveCafe24CouponOrder } from "../domain/cafe24-coupon-matcher";
import { CostRuleInput } from "../domain/margin-calculator";

// Do not change Prisma's shared Decimal configuration or legacy channel calculations.
const Money = Prisma.Decimal.clone({ precision: 80 });
type Amount = Prisma.Decimal;
export type GoogleSaleLine = {
  id: string; orderNo: string; connectionId: string | null; date: string;
  productId: string | null; productName: string | null; quantity: number;
  calculationQuantity?: number; collectedQuantity?: number;
  saleUnitLabel?: string | null;
  collectedSalePriceKrw: number | null; cost: CostRuleInput | null;
  couponInput: Cafe24CouponOrderLineInput;
  /** Invalid/out-of-range context rows still participate in coupon determination. */
  includeInSales?: boolean;
};
export type GoogleAdMetric = {
  id: string; date: string; connectionId: string; customerId: string;
  campaignId: string; campaignName: string; currencyCode: string;
  costMicros: string; impressions: number; clicks: number; productId: string | null;
  exchangeRateKrw?: string | null; timeZone?: string | null;
};
export type GooglePerformanceInput = {
  salesLines: GoogleSaleLine[]; adMetrics: GoogleAdMetric[];
  productId?: string;
  couponRules?: Cafe24CouponRuleInput[];
  days: { date: string; googleComplete: boolean; cafe24Complete: boolean }[];
  warnings?: string[];
};
type Bucket = {
  productId: string | null; date: string; quantity: number; lineCount: number;
  revenue: Amount; collected: Amount; gross: Amount; coupon: Amount; spend: Amount;
  missingRevenue: boolean; missingCollected: boolean; missingGross: boolean;
  missingCoupon: boolean; missingSpend: boolean; priceMismatchCount: number;
  warnings: Set<string>;
  unitLabels: Set<string>; unlabeledSales: boolean;
};
function empty(productId: string | null, date: string): Bucket {
  return { productId, date, quantity: 0, lineCount: 0,
    revenue: new Money(0), collected: new Money(0), gross: new Money(0),
    coupon: new Money(0), spend: new Money(0), missingRevenue: false,
    missingCollected: false, missingGross: false, missingCoupon: false,
    missingSpend: false, priceMismatchCount: 0, warnings: new Set(), unitLabels: new Set(), unlabeledSales: false };
}
function merge(target: Bucket, source: Bucket) {
  target.quantity += source.quantity; target.lineCount += source.lineCount;
  target.priceMismatchCount += source.priceMismatchCount;
  for (const key of ["revenue", "collected", "gross", "coupon", "spend"] as const)
    target[key] = target[key].plus(source[key]);
  for (const key of ["missingRevenue", "missingCollected", "missingGross", "missingCoupon", "missingSpend"] as const)
    target[key] ||= source[key];
  for (const warning of source.warnings) target.warnings.add(warning);
  for (const label of source.unitLabels) target.unitLabels.add(label);
  target.unlabeledSales ||= source.unlabeledSales;
}
function ratio(numerator: Amount, denominator: Amount): number | null {
  return denominator.isZero() ? null : numerator.dividedBy(denominator).toNumber();
}
function finish(bucket: Bucket) {
  const calculable = !bucket.missingRevenue && !bucket.missingGross && !bucket.missingCoupon && !bucket.missingSpend;
  const calculated = calculable ? bucket.revenue.minus(bucket.gross).minus(bucket.coupon).minus(bucket.spend) : null;
  const blocking = [...bucket.warnings].some((warning) => !["PRICE_MISMATCH", "COUPON_ESTIMATED"].includes(warning));
  const margin = blocking ? null : calculated;
  return {
    productId: bucket.productId, date: bucket.date, quantity: bucket.quantity,
    saleUnitLabel: !bucket.unlabeledSales && bucket.unitLabels.size === 1 ? [...bucket.unitLabels][0] : null,
    saleUnitLabels: [...bucket.unitLabels].sort(),
    lineCount: bucket.lineCount, revenueKrw: bucket.missingRevenue ? null : bucket.revenue.toNumber(),
    knownRevenueKrw: bucket.revenue.toNumber(),
    collectedRevenueKrw: bucket.missingCollected ? null : bucket.collected.toNumber(),
    grossCostKrw: bucket.missingGross ? null : bucket.gross.toNumber(),
    couponDeductionKrw: bucket.missingCoupon ? null : bucket.coupon.toNumber(),
    adSpendKrw: bucket.missingSpend ? null : bucket.spend.toNumber(),
    adSpendKrwExact: bucket.missingSpend ? null : bucket.spend.toFixed(),
    knownAdSpendKrw: bucket.spend.toNumber(),
    marginKrw: margin?.toNumber() ?? null,
    calculatedMarginKrw: calculated?.toNumber() ?? null,
    marginRate: margin ? ratio(margin, bucket.revenue) : null,
    roas: bucket.missingRevenue || bucket.missingSpend ? null : ratio(bucket.revenue, bucket.spend),
    priceMismatchCount: bucket.priceMismatchCount,
    complete: calculable && !blocking, warningCodes: [...bucket.warnings].sort()
  };
}

/** Loader must supply current, source-selected rows and effective dated product mappings/costs.
 * This module never reads or mutates Meta/Coupang data, mappings, or source history. */
export function calculateGooglePerformance(input: GooglePerformanceInput) {
  const buckets = new Map<string, Bucket>();
  const days = new Map(input.days.map((day) => [day.date, day]));
  const bucketFor = (productId: string | null, date: string) => {
    const key = JSON.stringify([productId, date]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = empty(productId, date);
      const day = days.get(date);
      if (!day?.googleComplete) { bucket.warnings.add("GOOGLE_COLLECTION_INCOMPLETE"); bucket.missingSpend = true; }
      if (!day?.cafe24Complete) bucket.warnings.add("CAFE24_COLLECTION_INCOMPLETE");
      for (const warning of input.warnings ?? []) bucket.warnings.add(warning);
      buckets.set(key, bucket);
    }
    return bucket;
  };
  // Group by connection as order numbers may collide between stores.
  const orders = new Map<string, GoogleSaleLine[]>();
  const seenSales = new Set<string>();
  for (const line of input.salesLines) {
    if (seenSales.has(line.id)) continue;
    seenSales.add(line.id);
    const key = JSON.stringify([line.connectionId, line.orderNo]);
    orders.set(key, [...(orders.get(key) ?? []), line]);
  }
  const couponByLine = new Map<string, number | null>();
  const estimatedCouponLines = new Set<string>();
  for (const lines of orders.values()) {
    const resolution = resolveCafe24CouponOrder({ orderNo: lines[0].orderNo,
      lines: lines.map((line) => ({ ...line.couponInput, productId: line.productId })),
      rules: input.couponRules ?? [] });
    if (resolution.status === "NO_COUPON") {
      for (const line of lines) couponByLine.set(line.id, 0);
      continue;
    }
    if (resolution.status !== "APPLIED" || resolution.couponDeductionKrw === null) {
      for (const line of lines) couponByLine.set(line.id, null);
      continue;
    }
    const rule = input.couponRules?.find((candidate) => candidate.id === resolution.selectedRuleId);
    const applicable = lines.filter((line) => resolution.selectedScope !== "PRODUCT" || line.productId === rule?.productId);
    const allocations = allocateOrderCoupon(resolution.couponDeductionKrw, applicable);
    for (const line of lines) {
      couponByLine.set(line.id, allocations === null ? null : allocations.get(line.id) ?? 0);
      if (resolution.confidence === "ESTIMATED") estimatedCouponLines.add(line.id);
    }
  }
  const unmappedSales: { id: string; date: string; connectionId: string | null; orderNo: string; productName: string | null;
    quantity: number; collectedRevenueKrw: number | null }[] = [];
  for (const lines of orders.values()) for (const line of lines) {
    if (line.includeInSales === false || !line.productName?.includes("[유튜브]")) continue;
    if (input.productId && input.productId !== line.productId) continue;
    const bucket = bucketFor(line.productId, line.date);
    bucket.quantity += line.quantity; bucket.lineCount += 1;
    if (line.saleUnitLabel) bucket.unitLabels.add(line.saleUnitLabel);
    else bucket.unlabeledSales = true;
    const collectedQuantity = line.collectedQuantity ?? line.quantity;
    const collected = line.collectedSalePriceKrw === null ? null : new Money(line.collectedSalePriceKrw).times(collectedQuantity);
    if (collected === null) bucket.missingCollected = true;
    else bucket.collected = bucket.collected.plus(collected);
    if (!line.productId) {
      bucket.warnings.add("UNMAPPED_SALES");
      unmappedSales.push({ id: line.id, date: line.date, connectionId: line.connectionId,
        orderNo: line.orderNo, productName: line.productName, quantity: line.quantity,
        collectedRevenueKrw: collected?.toNumber() ?? null });
    }
    if (!line.cost) {
      bucket.missingRevenue = true; bucket.missingGross = true; bucket.warnings.add("MISSING_COST_RULE");
    } else {
      const quantity = line.calculationQuantity ?? line.quantity;
      bucket.revenue = bucket.revenue.plus(new Money(line.cost.salePriceKrw).times(quantity));
      const unitCost = new Money(line.cost.vatKrw).plus(line.cost.productCostKrw).plus(line.cost.shippingKrw).plus(line.cost.extraCostKrw);
      bucket.gross = bucket.gross.plus(unitCost.times(quantity));
      if (collected !== null && !collected.equals(new Money(line.cost.salePriceKrw).times(quantity))) {
        bucket.priceMismatchCount += 1; bucket.warnings.add("PRICE_MISMATCH");
      }
    }
    const coupon = couponByLine.get(line.id);
    if (coupon === null || coupon === undefined) { bucket.missingCoupon = true; bucket.warnings.add("COUPON_UNRESOLVED"); }
    else bucket.coupon = bucket.coupon.plus(coupon);
    if (estimatedCouponLines.has(line.id)) bucket.warnings.add("COUPON_ESTIMATED");
  }

  const campaigns = new Map<string, { connectionId: string; customerId: string; campaignId: string; campaignName: string;
    currencyCode: string; productIds: Set<string>; hasUnmapped: boolean; spend: Amount; costMicros: Amount;
    missingSpend: boolean; impressions: number; clicks: number; warnings: Set<string> }>();
  const currencyMicros = new Map<string, { total: Amount; allocated: Amount; unallocated: Amount }>();
  const seenMetrics = new Set<string>();
  let collectedSpend = new Money(0), allocated = new Money(0), unallocated = new Money(0), missingFx = false;
  for (const metric of input.adMetrics) {
    if (input.productId && input.productId !== metric.productId) continue;
    if (seenMetrics.has(metric.id)) continue;
    seenMetrics.add(metric.id);
    const micros = new Money(metric.costMicros);
    if (!micros.isInteger() || micros.isNegative()) throw new Error("Google costMicros must be a non-negative integer");
    const currency = metric.currencyCode.toUpperCase();
    const rate = currency === "KRW" ? new Money(1) : metric.exchangeRateKrw == null ? null : new Money(metric.exchangeRateKrw);
    const spend = rate && rate.isFinite() && rate.greaterThan(0) ? micros.dividedBy(1_000_000).times(rate) : null;
    const bucket = bucketFor(metric.productId, metric.date);
    const key = JSON.stringify([metric.connectionId, metric.customerId, metric.campaignId, currency]);
    let campaign = campaigns.get(key);
    if (!campaign) {
      campaign = { connectionId: metric.connectionId, customerId: metric.customerId, campaignId: metric.campaignId,
        campaignName: metric.campaignName, currencyCode: currency, productIds: new Set(), hasUnmapped: false,
        spend: new Money(0), costMicros: new Money(0), missingSpend: false, impressions: 0, clicks: 0, warnings: new Set() };
      campaigns.set(key, campaign);
    }
    campaign.campaignName = metric.campaignName;
    campaign.costMicros = campaign.costMicros.plus(micros);
    campaign.impressions += metric.impressions; campaign.clicks += metric.clicks;
    if (metric.productId) campaign.productIds.add(metric.productId);
    else { campaign.hasUnmapped = true; bucket.warnings.add("UNALLOCATED_AD_SPEND"); campaign.warnings.add("UNALLOCATED_AD_SPEND"); }
    if (spend === null) {
      bucket.missingSpend = true; campaign.missingSpend = true; missingFx = true;
      bucket.warnings.add("MISSING_EXCHANGE_RATE"); campaign.warnings.add("MISSING_EXCHANGE_RATE");
    } else {
      collectedSpend = collectedSpend.plus(spend);
      bucket.spend = bucket.spend.plus(spend); campaign.spend = campaign.spend.plus(spend);
      if (metric.productId) allocated = allocated.plus(spend); else unallocated = unallocated.plus(spend);
    }
    if (metric.timeZone !== "Asia/Seoul") {
      const warning = metric.timeZone ? "TIME_ZONE_MISMATCH" : "TIME_ZONE_UNKNOWN";
      bucket.warnings.add(warning); campaign.warnings.add(warning);
    }
    const amounts = currencyMicros.get(currency) ?? { total: new Money(0), allocated: new Money(0), unallocated: new Money(0) };
    amounts.total = amounts.total.plus(micros);
    if (metric.productId) amounts.allocated = amounts.allocated.plus(micros); else amounts.unallocated = amounts.unallocated.plus(micros);
    currencyMicros.set(currency, amounts);
  }
  const summary = empty(null, "");
  for (const warning of input.warnings ?? []) summary.warnings.add(warning);
  const missingGoogleDates = input.days.filter((day) => !day.googleComplete).map((day) => day.date);
  const missingCafe24Dates = input.days.filter((day) => !day.cafe24Complete).map((day) => day.date);
  if (missingGoogleDates.length || !input.days.length) { summary.missingSpend = true; summary.warnings.add("GOOGLE_COLLECTION_INCOMPLETE"); }
  if (missingCafe24Dates.length || !input.days.length) summary.warnings.add("CAFE24_COLLECTION_INCOMPLETE");
  const products = new Map<string, Bucket>();
  for (const bucket of buckets.values()) {
    merge(summary, bucket);
    if (bucket.productId) {
      const product = products.get(bucket.productId) ?? empty(bucket.productId, "");
      merge(product, bucket); products.set(bucket.productId, product);
    }
  }
  // A missing day can hide sales or spend for any product, including products that
  // have no row on that day. Never turn such period totals into final margins.
  for (const product of products.values()) {
    if (missingGoogleDates.length) { product.missingSpend = true; product.warnings.add("GOOGLE_COLLECTION_INCOMPLETE"); }
    if (missingCafe24Dates.length) product.warnings.add("CAFE24_COLLECTION_INCOMPLETE");
  }
  for (const campaign of campaigns.values()) {
    if (missingGoogleDates.length) campaign.warnings.add("GOOGLE_COLLECTION_INCOMPLETE");
    for (const warning of input.warnings ?? []) campaign.warnings.add(warning);
  }
  const daily = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.productId ?? "").localeCompare(b.productId ?? "")).map(finish);
  const productRows = [...products.values()].sort((a, b) => a.productId!.localeCompare(b.productId!)).map(finish);
  const campaignRows = [...campaigns.values()].map((row) => ({
    connectionId: row.connectionId, customerId: row.customerId, campaignId: row.campaignId, campaignName: row.campaignName,
    currencyCode: row.currencyCode, productIds: [...row.productIds].sort(), hasUnmapped: row.hasUnmapped,
    costMicros: row.costMicros.toFixed(0), adSpendKrw: row.missingSpend ? null : row.spend.toNumber(),
    adSpendKrwExact: row.missingSpend ? null : row.spend.toFixed(),
    impressions: row.impressions, clicks: row.clicks,
    ctr: row.impressions === 0 ? null : row.clicks / row.impressions,
    cpcKrw: row.missingSpend || row.clicks === 0 ? null : row.spend.dividedBy(row.clicks).toNumber(),
    warningCodes: [...row.warnings].sort()
  }));
  return {
    summary: { ...finish(summary),
      calculatedProductsMarginKrw: productRows.reduce((sum, row) => sum + (row.calculatedMarginKrw ?? 0), 0),
      unallocatedAdSpendKrw: missingFx ? null : unallocated.toNumber(),
      allocatedAdSpendKrw: missingFx ? null : allocated.toNumber(),
      unmappedSalesCount: unmappedSales.length },
    products: productRows, daily, campaigns: campaignRows, unmappedSales,
    completeness: { complete: finish(summary).complete, missingGoogleDates, missingCafe24Dates,
      completeDates: input.days.filter((day) => day.googleComplete && day.cafe24Complete).map((day) => day.date),
      warningCodes: [...summary.warnings].sort() },
    reconciliation: {
      scope: input.productId ? "PRODUCT" as const : "SELECTED_ACCOUNTS" as const,
      productId: input.productId ?? null,
      collectedAdSpendKrwExact: missingFx ? null : collectedSpend.toFixed(),
      allocatedAdSpendKrwExact: missingFx ? null : allocated.toFixed(),
      unallocatedAdSpendKrwExact: missingFx ? null : unallocated.toFixed(),
      balanced: collectedSpend.equals(allocated.plus(unallocated)) && [...currencyMicros.values()]
        .every((amounts) => amounts.total.equals(amounts.allocated.plus(amounts.unallocated))),
      byCurrency: [...currencyMicros.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, amounts]) => ({
        currencyCode, collectedCostMicros: amounts.total.toFixed(0), allocatedCostMicros: amounts.allocated.toFixed(0),
        unallocatedCostMicros: amounts.unallocated.toFixed(0), balanced: amounts.total.equals(amounts.allocated.plus(amounts.unallocated))
      }))
    }
  };
}

/** Coupon selection preserves existing rules; allocation is at order-line level
 * before channel filtering, so mixed pages for the same product stay separate. */
function allocateOrderCoupon(total: number, lines: GoogleSaleLine[]): Map<string, number> | null {
  if (!Number.isSafeInteger(total) || total < 0 || !lines.length) return null;
  if (lines.some((line) => line.collectedSalePriceKrw === null || line.collectedSalePriceKrw < 0)) return null;
  const weights = lines.map((line) => ({ id: line.id,
    weight: new Money(line.collectedSalePriceKrw!).times(line.collectedQuantity ?? line.quantity) }));
  if (weights.some((row) => row.weight.isNegative() || !row.weight.isFinite())) return null;
  const sum = weights.reduce((value, row) => value.plus(row.weight), new Money(0));
  if (sum.lessThanOrEqualTo(0)) return null;
  const shares = weights.map((row) => {
    const exact = new Money(total).times(row.weight).dividedBy(sum);
    return { id: row.id, amount: exact.floor(), remainder: exact.minus(exact.floor()) };
  });
  const remaining = new Money(total).minus(shares.reduce((value, row) => value.plus(row.amount), new Money(0))).toNumber();
  shares.sort((a, b) => b.remainder.comparedTo(a.remainder) || a.id.localeCompare(b.id));
  for (let index = 0; index < remaining; index += 1) shares[index].amount = shares[index].amount.plus(1);
  return new Map(shares.map((row) => [row.id, row.amount.toNumber()]));
}
