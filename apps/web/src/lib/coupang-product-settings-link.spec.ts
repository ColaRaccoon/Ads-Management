import { describe, expect, it } from "vitest";
import { coupangProductIdFromSearch, coupangProductSettingsHref } from "./coupang-product-settings-link";

describe("Coupang product settings deep link", () => {
  it("round-trips an encoded product id", () => {
    const href = coupangProductSettingsHref("product / 한글");

    expect(href).toBe("/coupang/products?productId=product%20%2F%20%ED%95%9C%EA%B8%80");
    expect(coupangProductIdFromSearch(href.split("?")[1])).toBe("product / 한글");
  });
});
