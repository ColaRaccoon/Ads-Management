import { describe, expect, it } from "vitest";
import { buildCoupangCostPayload, type CoupangCostForm } from "./coupang-cost-form";

const form = (overrides: Partial<CoupangCostForm> = {}): CoupangCostForm => ({
  salePriceKrw: "49,800", supplyPriceKrw: "15,000", productCostKrw: "12,800",
  sellerShippingFeeKrw: "2,800", hanaroShippingFeeKrw: "260",
  growthInboundFeeKrw: "0", growthShippingFeeKrw: "2,250",
  returnRate: "0", returnCostPerUnitKrw: "0", extraCostKrw: "0",
  legacySalesFeePercent: "11.88", effectiveFrom: "2026-07-23", ...overrides
});

describe("Coupang cost payload", () => {
  it("includes comma-formatted supply and product costs together", () => {
    expect(buildCoupangCostPayload(form())).toMatchObject({ supplyPriceKrw: 15_000, productCostKrw: 12_800 });
  });
  it("keeps explicit zeroes", () => expect(buildCoupangCostPayload(form({ productCostKrw: "0" }))).toHaveProperty("productCostKrw", 0));
  it("omits empty ordinary costs but sends empty nullable shipping fees as null", () => {
    const payload = buildCoupangCostPayload(form({ productCostKrw: "", sellerShippingFeeKrw: "" }));
    expect(payload).not.toHaveProperty("productCostKrw");
    expect(payload.sellerShippingFeeKrw).toBeNull();
  });
  it("includes effectiveFrom and an explicitly requested legacy fee", () => {
    expect(buildCoupangCostPayload(form(), { includeLegacySalesFee: true })).toMatchObject({ effectiveFrom: "2026-07-23", salesFeeRate: 0.1188 });
  });
  it.each(["12,800원", "-1", "1.5"])("refuses invalid %s", (productCostKrw) => {
    expect(() => buildCoupangCostPayload(form({ productCostKrw }))).toThrow("금액 입력을 확인하세요");
  });
});
