import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { MarginCalculator } from "../apps/api/src/domain/margin-calculator";
import { Cafe24SalesCalculator } from "../apps/api/src/domain/cafe24-sales-calculator";
import { calculateCoupangProfitBySegments } from "../apps/api/src/domain/coupang-profit-calculator";
import { Cafe24CsvParser } from "../apps/api/src/domain/cafe24-csv";
import { normalizeCafe24Order } from "../apps/api/src/daily-sync/cafe24-order-adapter";

// Fixed historical inputs recorded against 92e4772 before Google implementation.
// These assert the existing channels' deliberately different VAT/shipping semantics.
export function legacyChannelSnapshot() {
  const cost = { salePriceKrw: 50000, vatKrw: 5000, productCostKrw: 12000, shippingKrw: 2500, extraCostKrw: 500 };
  const cafe = new Cafe24SalesCalculator();
  return {
    meta: new MarginCalculator().margin({ spendUsd: 10, purchaseCount: 2, exchangeRateKrwPerUsd: 1400 }, cost),
    cafe: cafe.calculate({ quantity: 2, adSpendUsd: 10, exchangeRateKrwPerUsd: 1400,
      cost: cafe.resolveCost(cost, { salePriceKrwOverride: 45000, shippingKrwOverride: 0 }) }),
    coupang: calculateCoupangProfitBySegments({
      segments: [{ fulfillmentMethod: "SELLER", netSalesKrw: 55000, salesQuantity: 1 },
        { fulfillmentMethod: "GROWTH", netSalesKrw: 55000, salesQuantity: 1 }],
      cost: { productCostKrw: 10000, sellerShippingFeeKrw: 3000, hanaroShippingFeeKrw: 1000,
        growthInboundFeeKrw: 500, growthShippingFeeKrw: 1500, returnRate: 0.1, returnCostPerUnitKrw: 5000, extraCostKrw: 500 },
      ads: { adSpendKrw: 10000, adGeneratedSalesKrw: 60000, attributedConversionSalesKrw: 40000 }, salesFeeRate: 0.1
    })
  };
}

test("fixed Meta, Cafe24 and Coupang baseline retains independent historical calculations", () => {
  const { meta, cafe, coupang } = legacyChannelSnapshot();
  assert.deepEqual(meta, { spendKrw: 14000, revenueKrw: 100000, grossCostKrw: 40000,
    marginKrw: 46000, cpaKrw: 7000, cpaUsd: 5, roas: 100000 / 14000 });
  assert.deepEqual(cafe, { quantity: 2, revenueKrw: 90000, grossCostKrw: 34000, adSpendUsd: 10,
    adSpendKrw: 14000, totalCostKrw: 48000, marginKrw: 42000, roas: 90000 / 14000, cpaKrw: 7000, marginRate: 42000 / 90000 });
  assert.deepEqual(coupang, { netSalesKrw: 110000, productCostKrw: 20000, salesFeeKrw: 11000,
    shippingCostKrw: 6000, returnCostKrw: 1000, extraCostKrw: 1000, vatKrw: 10000,
    adSpendKrw: 10000, totalCostKrw: 59000, marginKrw: 51000, marginRate: 51000 / 110000,
    roas: 6, organicSalesKrw: 70000, warnings: [], sellerSalesQuantity: 1, growthSalesQuantity: 1,
    sellerShippingCostKrw: 3000, hanaroShippingCostKrw: 1000, growthInboundCostKrw: 500,
    growthShippingCostKrw: 1500, totalLogisticsCostKrw: 6000 });
});

test("API projection preserves sale-time productName separately from option and repeated order payment", () => {
  const rows = normalizeCafe24Order({ order_id: "fixture-order", shop_no: 1, currency: "KRW",
    order_date: "2026-10-20T12:00:00+09:00", payment_amount: "150000", payment_method: ["card"] },
  ["[유튜브] 상품", "일반 상품"].map((name, index) => ({ order_item_code: `fixture-${index}`,
    product_no: String(index + 1), product_name: name, option_value: "[유튜브] 옵션",
    quantity: "1", product_price: "75000", order_status: "N10" })),
  { verifiedSellerDropdown: true, csvOptionEvidence: { mallId: "didadi0729", shopKey: "shop1" } });
  assert.deepEqual(rows.map(row => [row.productName, row.productNo]), [["[유튜브] 상품", "1"], ["일반 상품", "2"]]);
  assert.equal(rows.filter(row => row.productName.includes("[유튜브]")).length, 1);
  assert.deepEqual(rows.map(row => row.totalPaidKrw), ["150000.00", "150000.00"]);
  assert.ok(rows.every(row => row.cancelAmountKrw === null && row.refundAmountKrw === null));
});

test("CSV uses product name field; option-only marker never changes sale-time name", () => {
  const parser = new Cafe24CsvParser();
  const raw = { "주문번호": "fixture-order", "품목별 주문번호": "fixture-line", "총 결제금액": "100000",
    "상품번호": "77", "주문상품명": "일반 상품", "주문상품명(옵션포함)": "일반 상품([유튜브] 옵션)",
    "수량": "2", "판매가": "50000", "결제수단": "신용카드", "발주일": "2026-10-20 12:00:00" };
  const row = parser.parseRow(raw);
  assert.equal(row.issues.length, 0);
  assert.equal(row.parsedRow?.productName, "일반 상품");
  assert.equal(row.parsedRow?.productNo, "77");
  assert.equal(parser.parseRow({ ...raw, "주문상품명": "상품 [유튜브]" }).parsedRow?.productName, "상품 [유튜브]");
});
