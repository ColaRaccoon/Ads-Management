import { createHash } from "node:crypto";
import { CoupangProductMatcher, type CoupangMatchResult, type CoupangRuleInput } from "./coupang-product-matcher";

type DateValue = string | Date;
type Money = unknown;
type Source = { id: string; rowNumber: number; uploadBatchId?: string; validationStatus?: string;
  validationErrors?: unknown; batch?: { originalFilename: string } };
export type MappingReviewInput = {
  rules: CoupangRuleInput[];
  products: { id: string; displayName: string; standardName?: string; isActive?: boolean }[];
  sales: (Source & { saleDate: DateValue | null; productName: string; optionName: string; optionId?: string | null;
    netSalesKrw: Money; coupangProductId: string | null; coupangProductRuleId?: string | null })[];
  ads: (Source & { metricDate: DateValue; adExecutionProductName: string; adName?: string | null; conversionProductName: string;
    adExecutionOptionId?: string | null; conversionOptionId?: string | null; adSpendKrw: Money; totalConversionSales1dKrw: Money;
    spendProductId: string | null; conversionProductId: string | null; spendProductRuleId?: string | null; conversionProductRuleId?: string | null })[];
  promotions: (Source & { promotionStartDate: DateValue; promotionEndDate: DateValue; productText: string; optionId?: string | null;
    promotionStatus?: string | null; promotionPriceKrw: Money; coupangProductId: string | null; coupangProductRuleId?: string | null })[];
};
export type MappingReviewRow = {
  rowId: string; date: string; sourceName: string; rowNumber: number; targetKind: string;
  productName: string; optionName: string; optionId: string | null; amountKrw: number;
  beforeProductId: string | null; beforeProductName: string | null; afterProductId: string | null; afterProductName: string | null;
  beforeRuleId: string | null; afterRuleId: string | null; reason: string; candidates: string[]; reviewReasons: string[];
  change: "RESOLVED" | "REASSIGNED" | "LOST" | "UNCHANGED"; needsReview: boolean;
};
const day = (value: DateValue | null) => value instanceof Date ? value.toISOString().slice(0, 10) : value?.slice(0, 10) ?? "";

/** Re-evaluates every source target, including already matched rows. No persistence. */
export function reviewCoupangMappings(input: MappingReviewInput) {
  const matcher = new CoupangProductMatcher(), rows: MappingReviewRow[] = [];
  const names = new Map(input.products.map(product => [product.id, product.displayName]));
  const add = (source: Source, date: DateValue | null, targetKind: string, productName: string, optionName: string,
    optionId: string | null | undefined, amount: Money, before: string | null, beforeRuleId: string | null | undefined,
    result: CoupangMatchResult, extraReasons: string[] = []) => {
    const after = result.productId;
    const change = before === after ? "UNCHANGED" : !before ? "RESOLVED" : !after ? "LOST" : "REASSIGNED";
    const reviewReasons = [...result.reviewReasons, ...extraReasons];
    rows.push({ rowId: `${source.id}:${targetKind}`, date: day(date), sourceName: source.batch?.originalFilename ?? "",
      rowNumber: source.rowNumber, targetKind, productName, optionName, optionId: optionId ?? null, amountKrw: Number(amount ?? 0),
      beforeProductId: before, beforeProductName: before ? names.get(before) ?? before : null,
      afterProductId: after, afterProductName: after ? names.get(after) ?? after : null,
      beforeRuleId: beforeRuleId ?? null, afterRuleId: result.matchRuleId, reason: result.reason, candidates: result.candidates,
      change, reviewReasons, needsReview: change !== "UNCHANGED" || result.reason !== "MATCHED" || reviewReasons.length > 0 });
  };
  for (const sale of input.sales) add(sale, sale.saleDate, "SALES_PRODUCT", sale.productName, sale.optionName, sale.optionId,
    sale.netSalesKrw, sale.coupangProductId, sale.coupangProductRuleId, matcher.matchProduct(sale, input.rules, sale.saleDate));
  for (const ad of input.ads) {
    const result = matcher.matchAdProducts(ad, input.rules, ad.metricDate);
    add(ad, ad.metricDate, "ADS_SPEND_PRODUCT", result.spendText, "", ad.adExecutionOptionId, ad.adSpendKrw,
      ad.spendProductId, ad.spendProductRuleId, result.spend);
    // A placeholder with no conversion is not a missing-product issue, but an inferred positive amount must be reviewed.
    if (!result.conversionMissing || Number(ad.totalConversionSales1dKrw) !== 0) add(ad, ad.metricDate, "ADS_CONVERSION_PRODUCT",
      ad.conversionProductName, "", ad.conversionOptionId, ad.totalConversionSales1dKrw, ad.conversionProductId,
      ad.conversionProductRuleId, result.conversion, result.inferred ? ["POSITIVE_CONVERSION_WITHOUT_PRODUCT_NAME"] : []);
  }
  for (const promotion of input.promotions) add(promotion, promotion.promotionStartDate, "PROMOTION_PRODUCT", promotion.productText, "",
    promotion.optionId, promotion.promotionPriceKrw, promotion.coupangProductId, promotion.coupangProductRuleId,
    matcher.matchText(promotion.productText, input.rules, promotion.promotionStartDate));
  // IDs are diagnostic evidence only, never a replacement for source names/options.
  const optionProducts = new Map<string, Set<string>>();
  for (const row of rows) if (row.optionId && !["-", "0"].includes(row.optionId) && row.productName.trim() !== "-") {
    const product = row.afterProductId ?? row.beforeProductId;
    if (!product) continue;
    const products = optionProducts.get(row.optionId) ?? new Set<string>(); products.add(product); optionProducts.set(row.optionId, products);
  }
  for (const row of rows) if (row.optionId && (optionProducts.get(row.optionId)?.size ?? 0) > 1) {
    row.reviewReasons.push("SOURCE_OPTION_IDENTITY_CONFLICT"); row.needsReview = true;
  }
  rows.sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || b.date.localeCompare(a.date) || a.rowId.localeCompare(b.rowId));
  const amounts = Object.fromEntries(["SALES_PRODUCT", "ADS_SPEND_PRODUCT", "ADS_CONVERSION_PRODUCT", "PROMOTION_PRODUCT"].map(target => {
    const selected = rows.filter(row => row.targetKind === target);
    const sum = (predicate: (row: MappingReviewRow) => boolean) => selected.filter(predicate).reduce((value, row) => value + row.amountKrw, 0);
    return [target, { source: sum(() => true), matchedBefore: sum(row => !!row.beforeProductId), matchedAfter: sum(row => !!row.afterProductId),
      unmatchedAfter: sum(row => !row.afterProductId), changed: sum(row => row.change !== "UNCHANGED") }];
  }));
  return { rows, summary: { totalCount: rows.length, sourceRowCount: input.sales.length + input.ads.length + input.promotions.length,
    resolvedCount: rows.filter(row => row.change === "RESOLVED").length, reassignedCount: rows.filter(row => row.change === "REASSIGNED").length,
    lostCount: rows.filter(row => row.change === "LOST").length, unchangedCount: rows.filter(row => row.change === "UNCHANGED").length,
    reviewCount: rows.filter(row => row.needsReview).length, unmatchedAfterCount: rows.filter(row => !row.afterProductId).length,
    optionIdentityConflictCount: [...optionProducts.values()].filter(products => products.size > 1).length }, amounts };
}

export function coupangMappingReviewToken(input: MappingReviewInput, from: string, to: string) {
  // Source/rule evidence, including prior assignments, binds the preview to its exact period and snapshot.
  return createHash("sha256").update(JSON.stringify(["coupang-mapping-review-v1", from, to, input])).digest("hex");
}
