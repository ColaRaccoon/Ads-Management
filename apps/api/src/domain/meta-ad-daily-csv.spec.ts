import { describe, expect, it } from "vitest";
import { isPurchaseResult } from "./meta-ad-daily-csv";

describe("MetaAdDailyCsvParser purchase result detection", () => {
  it("treats Meta custom offsite conversions as purchase results", () => {
    expect(isPurchaseResult("actions:offsite_conversion.custom.1532866761891806")).toBe(true);
    expect(isPurchaseResult("actions:offsite_conversion.custom.4457913227780992")).toBe(true);
  });
});
