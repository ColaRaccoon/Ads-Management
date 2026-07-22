import { describe, expect, it } from "vitest";
import { coupangShippingFeePayload } from "./coupang-shipping-payload";

describe("Coupang shipping payload", () => {
  it("keeps blank shipping fields as explicit nulls through JSON serialization", () => {
    const json = JSON.stringify(coupangShippingFeePayload({
      sellerShippingFeeKrw: "",
      hanaroShippingFeeKrw: "  "
    }));

    expect(JSON.parse(json)).toEqual({
      sellerShippingFeeKrw: null,
      hanaroShippingFeeKrw: null
    });
  });

  it("keeps explicit zero shipping fields as numeric zero", () => {
    const payload = coupangShippingFeePayload({
      sellerShippingFeeKrw: "0",
      hanaroShippingFeeKrw: "0"
    });

    expect(payload).toEqual({ sellerShippingFeeKrw: 0, hanaroShippingFeeKrw: 0 });
    expect(JSON.stringify(payload)).toContain('"sellerShippingFeeKrw":0');
    expect(JSON.stringify(payload)).toContain('"hanaroShippingFeeKrw":0');
  });
});
