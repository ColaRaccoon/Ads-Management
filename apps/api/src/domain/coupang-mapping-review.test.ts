import assert from "node:assert/strict";
import test from "node:test";
import { coupangMappingReviewToken, reviewCoupangMappings, type MappingReviewInput } from "./coupang-mapping-review";
const base = (): MappingReviewInput => ({ products: [{ id: "p", displayName: "베놈 1개" }],
  rules: [{ id: "r", productId: "p", includeKeywords: ["베놈", "1개"], excludeKeywords: [], priority: 100 }],
  sales: [{ id: "sale", rowNumber: 1, saleDate: "2026-10-01", productName: "베놈", optionName: "1개", netSalesKrw: 100,
    coupangProductId: "p", coupangProductRuleId: "r" }], ads: [], promotions: [] });
test("all matched rows are audited; changed and newly unmatched assignments are distinct", () => {
  const input = base();
  input.sales.push({ ...input.sales[0], id: "wrong", optionName: "11개", netSalesKrw: -20 });
  input.sales.push({ ...input.sales[0], id: "unmatched", coupangProductId: null, netSalesKrw: 50 });
  input.sales.push({ ...input.sales[0], id: "reassigned", coupangProductId: "old", netSalesKrw: 30 });
  const review = reviewCoupangMappings(input);
  assert.equal(review.summary.totalCount, 4); assert.equal(review.summary.unchangedCount, 1);
  assert.equal(review.summary.lostCount, 1); assert.equal(review.summary.resolvedCount, 1); assert.equal(review.summary.reassignedCount, 1);
  const totals = review.amounts.SALES_PRODUCT;
  assert.equal(totals.source, 160); assert.equal(totals.matchedAfter + totals.unmatchedAfter, totals.source);
  assert.equal(review.rows.find(row => row.change === "LOST")?.optionName, "11개");
});
test("spend and conversion are audited separately; positive unnamed conversion is flagged", () => {
  const input = base(); input.sales = [];
  input.ads = [{ id: "ad", rowNumber: 2, metricDate: "2026-10-01", adExecutionProductName: "베놈 1개", conversionProductName: "-",
    adSpendKrw: 9, totalConversionSales1dKrw: 100, spendProductId: "p", conversionProductId: "p" }];
  const review = reviewCoupangMappings(input);
  assert.equal(review.amounts.ADS_SPEND_PRODUCT.source, 9); assert.equal(review.amounts.ADS_CONVERSION_PRODUCT.source, 100);
  assert.deepEqual(review.rows.find(row => row.targetKind === "ADS_CONVERSION_PRODUCT")?.reviewReasons, ["POSITIVE_CONVERSION_WITHOUT_PRODUCT_NAME"]);
});
test("preview token invalidates on source option, rule, previous mapping, or date changes", () => {
  const input = base(), token = () => coupangMappingReviewToken(input, "2026-10-01", "2026-10-02");
  const before = token(); input.sales[0].optionName = "2개"; assert.notEqual(token(), before);
  input.sales[0].optionName = "1개"; assert.equal(token(), before);
  input.rules[0].excludeKeywords = ["여성"]; assert.notEqual(token(), before);
  assert.notEqual(coupangMappingReviewToken(base(), "2026-10-01", "2026-10-03"), before);
  input.rules[0].excludeKeywords = []; input.sales[0].coupangProductId = null; assert.notEqual(token(), before);
});
test("same option ID with incompatible source identities is a diagnostic, never an automatic reassignment", () => {
  const input = base(); input.sales[0].optionId = "123";
  input.products.push({ id: "pair", displayName: "베놈 2개" });
  input.rules.push({ ...input.rules[0], id: "pair-rule", productId: "pair", includeKeywords: ["베놈", "2개"] });
  input.sales.push({ ...input.sales[0], id: "pair-sale", optionName: "2개", coupangProductId: "pair" });
  const review = reviewCoupangMappings(input);
  assert.equal(review.summary.optionIdentityConflictCount, 1); assert.equal(review.summary.unchangedCount, 2);
  assert.ok(review.rows.every(row => row.reviewReasons.includes("SOURCE_OPTION_IDENTITY_CONFLICT")));
  input.sales.forEach(row => { row.optionId = "0"; });
  assert.equal(reviewCoupangMappings(input).summary.optionIdentityConflictCount, 0);
});
