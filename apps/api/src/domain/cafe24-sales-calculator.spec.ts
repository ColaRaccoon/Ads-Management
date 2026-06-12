import { describe, expect, it } from "vitest";
import { Cafe24SalesCalculator } from "./cafe24-sales-calculator";

describe("Cafe24SalesCalculator", () => {
  const calculator = new Cafe24SalesCalculator();

  it("uses Cafe24 rule overrides for 1+1 style option costs", () => {
    const cost = calculator.resolveCost(
      {
        salePriceKrw: 38900,
        vatKrw: 3890,
        productCostKrw: 9000,
        shippingKrw: 3000,
        extraCostKrw: 0
      },
      {
        salePriceKrwOverride: 69000,
        productCostKrwOverride: 18000,
        shippingKrwOverride: 3000
      }
    );

    const result = calculator.calculate({
      quantity: 2,
      adSpendUsd: 10,
      exchangeRateKrwPerUsd: 1300,
      cost
    });

    expect(cost.salePriceKrw).toBe(69000);
    expect(cost.vatKrw).toBe(6900);
    expect(result.revenueKrw).toBe(138000);
    expect(result.adSpendKrw).toBe(13000);
    expect(result.grossCostKrw).toBe(55800);
    expect(result.marginKrw).toBe(69200);
    expect(result.roas).toBeCloseTo(138000 / 13000, 6);
  });
});
