import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReportedSalesByProductDate, aggregateManualPurchasesByProductDate,
  adjustReportedSalesForManualPurchase, calculateNormalCoupangProfit,
  calculateManualPurchaseProfitAdjustment, combineCoupangProfitParts } from "./coupang-profit-pipeline";

test("manual sales exceeding reported sales retain warnings and calculate a loss", () => {
  const reported = [...aggregateReportedSalesByProductDate([{productId:"p",date:"2026-10-30",
    salesKrw:10000,netSalesKrw:10000,cancelAmountKrw:0,salesQuantity:1,orderCount:1,saleMethod:"SELLER"}]).values()][0];
  const manual = [...aggregateManualPurchasesByProductDate([{productId:"p",date:"2026-10-30",
    quantity:2,salesAmountKrw:20000,vendorFeeKrw:2000,totalCostKrw:2000}]).values()][0];
  const actual = adjustReportedSalesForManualPurchase(reported,manual);
  assert.equal(actual.isValid,true);
  assert.equal(actual.netSalesKrw,-10000);
  assert.ok(actual.warnings.includes("MANUAL_PURCHASE_SALES_EXCEEDS_REPORTED"));
  assert.ok(actual.warnings.includes("MANUAL_PURCHASE_QUANTITY_EXCEEDS_REPORTED"));
  const input = {actual,cost:{productCostKrw:1000},ads:{adSpendKrw:0,adGeneratedSalesKrw:0,attributedConversionSalesKrw:0},salesFeeRate:0};
  const result = combineCoupangProfitParts({normal:calculateNormalCoupangProfit(input),manual:calculateManualPurchaseProfitAdjustment(manual)});
  assert.equal(result.calculationStatus,"COMPLETE");
  assert.ok(result.marginKrw !== null && result.marginKrw < 0);
  assert.equal(calculateNormalCoupangProfit({...input,cost:null}).status,"INCOMPLETE");
  const missing = adjustReportedSalesForManualPurchase(reported,{...manual,salesAmountKrw:null,warnings:["MANUAL_PURCHASE_SALES_AMOUNT_MISSING"]});
  assert.equal(missing.isValid,false);
});
