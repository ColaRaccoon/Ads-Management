import { describe, expect, it } from "vitest";
import fixture from "./fixtures/local-business-kpi-v1.json";
import { Cafe24SalesCalculator } from "../domain/cafe24-sales-calculator";
import { calculateCoupangProfit } from "../domain/coupang-profit-calculator";
import { MarginCalculator } from "../domain/margin-calculator";

function expectNumbersClose(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === "number") {
      expect(actual[key], key).toBeCloseTo(value, 8);
    } else {
      expect(actual[key], key).toEqual(value);
    }
  }
}

describe("tracked local-business KPI fixture", () => {
  it("freezes the synthetic fixture schema version", () => {
    expect(fixture.version).toBe(1);
    expect(Object.keys(fixture).sort()).toEqual(["cafe24", "coupang", "meta", "version"]);
  });

  it("preserves Meta margin and CPA threshold results", () => {
    const calculator = new MarginCalculator();
    const actual = {
      ...calculator.margin(fixture.meta.metric, fixture.meta.cost),
      ...calculator.thresholds(fixture.meta.cost, fixture.meta.cpaRule)
    };
    expectNumbersClose(actual, fixture.meta.expected);
  });

  it("preserves Cafe24 override, margin, ROAS, and CPA results", () => {
    const calculator = new Cafe24SalesCalculator();
    const resolved = calculator.resolveCost(fixture.cafe24.baseCost, fixture.cafe24.override);
    const actual = {
      ...resolved,
      ...calculator.calculate({
        quantity: fixture.cafe24.quantity,
        adSpendUsd: fixture.cafe24.adSpendUsd,
        exchangeRateKrwPerUsd: fixture.cafe24.exchangeRateKrwPerUsd,
        cost: resolved
      })
    };
    expectNumbersClose(actual, fixture.cafe24.expected);
  });

  it("preserves Coupang cost, margin, ROAS, and organic-sales results", () => {
    const actual = calculateCoupangProfit(
      fixture.coupang.sales,
      fixture.coupang.cost,
      fixture.coupang.ads,
      fixture.coupang.options
    );
    expectNumbersClose(actual, fixture.coupang.expected);
  });
});
