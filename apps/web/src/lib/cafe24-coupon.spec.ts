import { describe, expect, it } from "vitest";
import {
  CAFE24_COUPON_DEPENDENT_QUERY_KEYS,
  CAFE24_COUPON_PRODUCTS_QUERY_KEY,
  CAFE24_COUPON_PRODUCTS_QUERY_PATH,
  couponAggregateLabel,
  couponAuditCategory,
  couponAuditLabel,
  couponProductLabel,
  couponScopeLabel,
  salesExcelDataLastRow
} from "./cafe24-coupon";

describe("Cafe24 coupon UI helpers", () => {
  it("distinguishes exact, estimated and unmatched audit rows", () => {
    expect(couponAuditCategory({ status: "APPLIED", confidence: "EXACT" })).toBe("EXACT");
    expect(couponAuditLabel({ status: "APPLIED", confidence: "ESTIMATED" })).toBe("추정");
    expect(couponAuditCategory({ status: "UNMATCHED", confidence: "NONE" })).toBe("UNMATCHED");
  });

  it("formats aggregate status and scope labels", () => {
    expect(couponAggregateLabel("MIXED")).toBe("혼합");
    expect(couponAggregateLabel("NO_COUPON")).toBe("쿠폰 없음");
    expect(couponScopeLabel("PRODUCT")).toBe("상품별");
    expect(couponScopeLabel("GLOBAL")).toBe("전체 상품");
  });

  it("prefers product names and falls back to embedded products or ids", () => {
    expect(couponProductLabel({ productNames: ["에어스텝퍼"], productIds: ["p1"] })).toBe("에어스텝퍼");
    expect(couponProductLabel({ products: [{ displayName: "웨이브바" }] })).toBe("웨이브바");
    expect(couponProductLabel({ productIds: ["p1", "p2"] })).toBe("p1, p2");
  });

  it("invalidates every cache affected by product coupon changes and deletion", () => {
    expect(CAFE24_COUPON_DEPENDENT_QUERY_KEYS).toEqual([
      ["cafe24-coupon-rules"],
      ["products"],
      ["sales-product-performance"],
      ["daily-report-sales-product-performance"]
    ]);
  });

  it("loads inactive products so preserved product coupons remain editable", () => {
    expect(CAFE24_COUPON_PRODUCTS_QUERY_PATH).toBe("/products?includeInactive=true");
    expect(CAFE24_COUPON_PRODUCTS_QUERY_KEY).toEqual(["products", "includeInactive"]);
    expect(CAFE24_COUPON_PRODUCTS_QUERY_KEY).not.toEqual(["products"]);
  });

  it("keeps the sales Excel total row outside the auto-filter range", () => {
    expect(salesExcelDataLastRow(15)).toBe(14);
  });
});
