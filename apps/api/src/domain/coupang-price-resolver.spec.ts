import { describe, expect, it } from "vitest";
import { resolveCoupangSalePrice } from "./coupang-price-resolver";
import { toDateOnly } from "./date-number";

describe("resolveCoupangSalePrice", () => {
  it("uses active promotion price over base price", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-06-22")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        }
      ]
    });

    expect(resolved).toMatchObject({
      salePriceKrw: 24050,
      baseSalePriceKrw: 25800,
      promotionPriceKrw: 24050,
      priceSource: "PROMOTION",
      priceWarnings: []
    });
  });

  it("falls back to base outside the promotion range", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-07-20")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        }
      ]
    });

    expect(resolved.salePriceKrw).toBe(25800);
    expect(resolved.priceSource).toBe("BASE");
  });

  it("ignores inactive promotion statuses", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-06-22")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!,
          promotionStatus: "취소"
        },
        {
          promotionPriceKrw: 24100,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!,
          promotionStatus: "중지"
        }
      ]
    });

    expect(resolved.salePriceKrw).toBe(25800);
    expect(resolved.priceSource).toBe("BASE");
  });

  it("ignores candidates carrying invalid promotion status warnings", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-06-22")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!,
          validationErrors: [{ errorCode: "INVALID_PROMOTION_STATUS" }]
        }
      ]
    });

    expect(resolved.salePriceKrw).toBe(25800);
    expect(resolved.priceSource).toBe("BASE");
  });

  it("uses one price when duplicate active promotions agree", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-06-22")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        },
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-20")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        }
      ]
    });

    expect(resolved.salePriceKrw).toBe(24050);
    expect(resolved.priceSource).toBe("PROMOTION");
  });

  it("falls back to base and warns when active promotions conflict", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 25800,
      date: toDateOnly("2026-06-22")!,
      promotions: [
        {
          promotionPriceKrw: 24050,
          promotionStartDate: toDateOnly("2026-06-19")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        },
        {
          promotionPriceKrw: 23900,
          promotionStartDate: toDateOnly("2026-06-20")!,
          promotionEndDate: toDateOnly("2026-07-19")!
        }
      ]
    });

    expect(resolved.salePriceKrw).toBe(25800);
    expect(resolved.priceSource).toBe("CONFLICT");
    expect(resolved.priceWarnings).toContain("PROMOTION_PRICE_CONFLICT");
  });

  it("treats zero base price as missing", () => {
    const resolved = resolveCoupangSalePrice({
      baseSalePriceKrw: 0,
      date: toDateOnly("2026-06-22")!,
      promotions: []
    });

    expect(resolved.salePriceKrw).toBeNull();
    expect(resolved.priceSource).toBe("MISSING");
  });
});
