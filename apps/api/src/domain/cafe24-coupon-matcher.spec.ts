import { describe, expect, it } from "vitest";
import {
  allocateNonNegativeByWeight,
  Cafe24CouponOrderLineInput,
  Cafe24CouponRuleInput,
  resolveCafe24CouponOrder
} from "./cafe24-coupon-matcher";

describe("resolveCafe24CouponOrder", () => {
  it("does not detect non-coupon payments or coupon-like substrings", () => {
    const noCoupon = resolve([line({ paymentMethod: "적립금,신용카드" })], [productRule()]);
    const substring = resolve([line({ paymentMethod: "쿠폰할인,쿠폰사용" })], [productRule()]);

    expect(noCoupon).toMatchObject({
      couponDetected: false,
      status: "NO_COUPON",
      confidence: "NONE",
      couponDeductionKrw: 0,
      warningCodes: []
    });
    expect(substring).toMatchObject({ couponDetected: false, couponDeductionKrw: 0 });
  });

  it("detects an exact coupon token among comma-separated payments", () => {
    expect(resolve([line({ paymentMethod: "쿠폰, 신용카드" })], [productRule()])).toMatchObject({
      couponDetected: true,
      status: "APPLIED"
    });
  });

  it("applies an exact product coupon once", () => {
    const result = resolve([line()], [productRule()]);

    expect(result).toMatchObject({
      status: "APPLIED",
      confidence: "EXACT",
      selectedRuleId: "product-5000",
      selectedScope: "PRODUCT",
      observedGapKrw: 5000,
      couponDeductionKrw: 5000,
      ignoredResidualKrw: 0
    });
    expect([...result.allocationsByProductId.entries()]).toEqual([["product-1", 5000]]);
  });

  it("applies an exact global coupon", () => {
    const result = resolve(
      [line({ totalPaidKrw: 89000 })],
      [globalRule({ id: "global-1000", discountKrw: 1000 })]
    );

    expect(result).toMatchObject({
      status: "APPLIED",
      confidence: "EXACT",
      selectedRuleId: "global-1000",
      selectedScope: "GLOBAL",
      couponDeductionKrw: 1000
    });
    expect(result.allocationsByProductId.get("product-1")).toBe(1000);
  });

  it("chooses the amount matching the observed gap across product and global candidates", () => {
    const rules = [productRule(), globalRule()];

    expect(resolve([line()], rules).selectedRuleId).toBe("product-5000");
    expect(resolve([line({ totalPaidKrw: 89000 })], rules).selectedRuleId).toBe("global-1000");
  });

  it("chooses the largest plausible coupon without summing candidates", () => {
    const rules = [
      globalRule({ id: "coupon-1000", discountKrw: 1000 }),
      globalRule({ id: "coupon-3000", discountKrw: 3000 }),
      globalRule({ id: "coupon-5000", discountKrw: 5000 })
    ];
    const result = resolve([line({ totalPaidKrw: 85500 })], rules);

    expect(result).toMatchObject({
      selectedRuleId: "coupon-3000",
      couponDeductionKrw: 3000,
      ignoredResidualKrw: 1500,
      confidence: "ESTIMATED"
    });
    expect(result.warningCodes).toContain("IGNORED_RESIDUAL_EXISTS");
  });

  it("applies 5,000 KRW to a 5,500 KRW gap and ignores the 500 KRW residual", () => {
    expect(resolve([line({ totalPaidKrw: 84500 })], [productRule()])).toMatchObject({
      selectedRuleId: "product-5000",
      couponDeductionKrw: 5000,
      ignoredResidualKrw: 500,
      confidence: "ESTIMATED",
      warningCodes: ["IGNORED_RESIDUAL_EXISTS"]
    });
  });

  it("does not apply a rule larger than the gap when it is outside tolerance", () => {
    expect(resolve([line({ totalPaidKrw: 89500 })], [globalRule()])).toMatchObject({
      status: "UNMATCHED",
      couponDeductionKrw: 0,
      warningCodes: ["NO_PLAUSIBLE_COUPON_AMOUNT"]
    });
  });

  it("excludes rules outside the order date or marked inactive", () => {
    const outside = productRule({
      id: "future",
      validFrom: date("2026-06-12")
    });
    const inactive = productRule({ id: "inactive", isActive: false });
    const expired = productRule({ id: "expired", validTo: date("2026-06-10") });

    expect(resolve([line()], [outside, inactive, expired])).toMatchObject({
      status: "UNMATCHED",
      candidateRuleIds: [],
      warningCodes: ["NO_ACTIVE_COUPON_RULE"]
    });
  });

  it("prefers a product rule over a global rule at the same amount", () => {
    const result = resolve(
      [line()],
      [
        globalRule({ id: "same-global", discountKrw: 5000, priority: 1 }),
        productRule({ id: "same-product", priority: 999 })
      ]
    );

    expect(result.selectedRuleId).toBe("same-product");
    expect(result.warningCodes).toContain("RULE_TIE_RESOLVED_BY_PRIORITY");
  });

  it("uses priority, validFrom, createdAt, and id as deterministic same-amount tie breakers", () => {
    const lowerPriority = resolve(
      [line()],
      [productRule({ id: "priority-20", priority: 20 }), productRule({ id: "priority-10", priority: 10 })]
    );
    const newerValidFrom = resolve(
      [line()],
      [
        productRule({ id: "valid-old", validFrom: date("2026-01-01") }),
        productRule({ id: "valid-new", validFrom: date("2026-06-01") })
      ]
    );
    const newerCreatedAt = resolve(
      [line()],
      [
        productRule({ id: "created-old", createdAt: new Date("2026-06-01T00:00:00.000Z") }),
        productRule({ id: "created-new", createdAt: new Date("2026-06-01T01:00:00.000Z") })
      ]
    );
    const lowestId = resolve(
      [line()],
      [productRule({ id: "b-rule" }), productRule({ id: "a-rule" })]
    );

    expect(lowerPriority.selectedRuleId).toBe("priority-10");
    expect(newerValidFrom.selectedRuleId).toBe("valid-new");
    expect(newerCreatedAt.selectedRuleId).toBe("created-new");
    expect(lowestId.selectedRuleId).toBe("a-rule");
  });

  it("applies at most one coupon for quantity two and repeated order lines", () => {
    const result = resolve(
      [
        line({ quantity: 2, salePriceKrw: 45000 }),
        line({ quantity: 2, salePriceKrw: 0 })
      ],
      [productRule(), globalRule()]
    );

    expect(result.couponDeductionKrw).toBe(5000);
    expect(result.selectedRuleId).toBe("product-5000");
    expect([...result.allocationsByProductId.values()].reduce((sum, value) => sum + value, 0)).toBe(5000);
  });

  it("does not apply when total order amount is missing", () => {
    expect(resolve([line({ totalOrderKrw: null })], [productRule()])).toMatchObject({
      status: "UNMATCHED",
      couponDeductionKrw: 0,
      warningCodes: ["MISSING_TOTAL_ORDER"]
    });
  });

  it("does not apply when the order contains an invalid source row", () => {
    expect(resolve([line(), line({ isValid: false })], [productRule()])).toMatchObject({
      status: "UNMATCHED",
      couponDeductionKrw: 0,
      warningCodes: ["INCOMPLETE_ORDER_DATA"]
    });
  });

  it("does not apply when repeated total order amounts differ by more than one KRW", () => {
    expect(
      resolve(
        [line({ totalOrderKrw: 90000 }), line({ totalOrderKrw: 90002 })],
        [productRule()]
      )
    ).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["INCONSISTENT_TOTAL_ORDER"]
    });
  });

  it("does not apply when repeated total paid amounts differ by more than one KRW", () => {
    expect(
      resolve(
        [line({ totalPaidKrw: 85000 }), line({ totalPaidKrw: 85002 })],
        [productRule()]
      )
    ).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["INCONSISTENT_TOTAL_PAID"]
    });
  });

  it("does not apply when repeated order dates differ", () => {
    expect(
      resolve(
        [line(), line({ orderDate: date("2026-06-12") })],
        [productRule()]
      )
    ).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["INCONSISTENT_ORDER_DATE"]
    });
  });

  it("does not apply for zero or negative observed gaps", () => {
    expect(resolve([line({ totalPaidKrw: 90000 })], [productRule()]).warningCodes).toEqual([
      "NON_POSITIVE_GAP"
    ]);
    expect(resolve([line({ totalPaidKrw: 91000 })], [productRule()]).warningCodes).toEqual([
      "NON_POSITIVE_GAP"
    ]);
  });

  it("allocates a global coupon proportionally across products with an exact total", () => {
    const result = resolve(
      [
        line({
          productId: "product-a",
          totalOrderKrw: 100000,
          totalPaidKrw: 99000,
          salePriceKrw: 30000
        }),
        line({
          productId: "product-b",
          totalOrderKrw: 100000,
          totalPaidKrw: 99000,
          salePriceKrw: 70000
        })
      ],
      [globalRule()]
    );

    expect(Object.fromEntries(result.allocationsByProductId)).toEqual({
      "product-a": 300,
      "product-b": 700
    });
    expect([...result.allocationsByProductId.values()].reduce((sum, value) => sum + value, 0)).toBe(
      result.couponDeductionKrw
    );
  });

  it("uses the final sorted product allocation for rounding remainder", () => {
    const result = resolve(
      [
        line({
          productId: "product-a",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 1
        }),
        line({
          productId: "product-b",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 1
        }),
        line({
          productId: "product-c",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 1
        })
      ],
      [globalRule({ discountKrw: 1001 })]
    );

    expect(Object.fromEntries(result.allocationsByProductId)).toEqual({
      "product-a": 334,
      "product-b": 334,
      "product-c": 333
    });
  });

  it("uses nonnegative largest-remainder shares when rounded allocations would overshoot", () => {
    const result = resolve(
      [
        line({
          productId: "product-a",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 5000
        }),
        line({
          productId: "product-b",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 5000
        }),
        line({
          productId: "product-c",
          totalOrderKrw: 10000,
          totalPaidKrw: 8999,
          salePriceKrw: 0
        })
      ],
      [globalRule({ discountKrw: 1001 })]
    );

    expect(Object.fromEntries(result.allocationsByProductId)).toEqual({
      "product-a": 501,
      "product-b": 500,
      "product-c": 0
    });
    expect([...result.allocationsByProductId.values()].every((amount) => amount >= 0)).toBe(true);
    expect([...result.allocationsByProductId.values()].reduce((sum, amount) => sum + amount, 0)).toBe(1001);
  });

  it("clamps negative and non-finite weights and preserves cent-level totals", () => {
    const allocation = allocateNonNegativeByWeight(
      10.01,
      new Map([
        ["product-a", 5],
        ["product-b", -10],
        ["product-c", Number.NaN],
        ["product-d", 5]
      ])
    );

    expect(Object.fromEntries(allocation ?? [])).toEqual({
      "product-a": 5.01,
      "product-b": 0,
      "product-c": 0,
      "product-d": 5
    });
    expect([...(allocation?.values() ?? [])].every((amount) => amount >= 0)).toBe(true);
    expect([...(allocation?.values() ?? [])].reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(10.01, 2);
  });

  it("does not allocate when any product is unmatched", () => {
    expect(
      resolve(
        [
          line({ productId: "product-1", totalPaidKrw: 89000 }),
          line({ productId: null, totalPaidKrw: 89000 })
        ],
        [globalRule()]
      )
    ).toMatchObject({
      status: "UNMATCHED",
      couponDeductionKrw: 0,
      warningCodes: ["PARTIAL_PRODUCT_MAPPING"]
    });

    expect(resolve([line({ productId: null })], [productRule()])).toMatchObject({
      status: "UNMATCHED",
      warningCodes: ["UNMATCHED_PRODUCT"]
    });
  });

  it("does not allocate a global coupon on a non-positive allocation base", () => {
    expect(
      resolve(
        [
          line({ productId: "product-a", totalPaidKrw: 89000, salePriceKrw: 0 }),
          line({ productId: "product-b", totalPaidKrw: 89000, salePriceKrw: 0 })
        ],
        [globalRule()]
      )
    ).toMatchObject({
      status: "UNMATCHED",
      selectedRuleId: null,
      couponDeductionKrw: 0,
      warningCodes: ["NON_POSITIVE_ALLOCATION_BASE"]
    });
  });

  it("allows zero total paid and returns the large ignored residual", () => {
    expect(resolve([line({ totalPaidKrw: 0 })], [productRule()])).toMatchObject({
      status: "APPLIED",
      confidence: "ESTIMATED",
      couponDeductionKrw: 5000,
      ignoredResidualKrw: 85000,
      warningCodes: ["IGNORED_RESIDUAL_EXISTS"]
    });
  });
});

function resolve(lines: Cafe24CouponOrderLineInput[], rules: Cafe24CouponRuleInput[]) {
  return resolveCafe24CouponOrder({ orderNo: "order-1", lines, rules });
}

function line(overrides: Partial<Cafe24CouponOrderLineInput> = {}): Cafe24CouponOrderLineInput {
  return {
    orderDate: date("2026-06-11"),
    paymentMethod: "쿠폰,신용카드",
    totalOrderKrw: 90000,
    totalPaidKrw: 85000,
    productId: "product-1",
    salePriceKrw: 90000,
    quantity: 1,
    ...overrides
  };
}

function productRule(overrides: Partial<Cafe24CouponRuleInput> = {}): Cafe24CouponRuleInput {
  return {
    id: "product-5000",
    name: "Product 5,000",
    scope: "PRODUCT",
    productId: "product-1",
    discountKrw: 5000,
    priority: 100,
    validFrom: date("2026-01-01"),
    validTo: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function globalRule(overrides: Partial<Cafe24CouponRuleInput> = {}): Cafe24CouponRuleInput {
  return {
    id: "global-1000",
    name: "Global 1,000",
    scope: "GLOBAL",
    productId: null,
    discountKrw: 1000,
    priority: 100,
    validFrom: date("2026-01-01"),
    validTo: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function date(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
