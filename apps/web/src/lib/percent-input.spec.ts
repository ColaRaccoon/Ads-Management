import { describe, expect, it } from "vitest";
import { normalizePercentInput, percentInputToRate, rateToPercentInput } from "./percent-input";

describe("percent input", () => {
  it("converts stored rates to human percent text", () => {
    expect(rateToPercentInput(0.1188)).toBe("11.88");
    expect(rateToPercentInput(0)).toBe("0");
    expect(rateToPercentInput(null)).toBe("");
  });

  it("converts human percent text to six-decimal stored rates", () => {
    expect(percentInputToRate("11.88")).toBe(0.1188);
    expect(percentInputToRate("0")).toBe(0);
    expect(percentInputToRate(" ")).toBeUndefined();
    expect(normalizePercentInput("11.8800")).toBe("11.88");
  });

  it.each(["-0.01", "100.01", "abc", "Infinity"])("rejects invalid percent %s", (value) => {
    expect(() => percentInputToRate(value)).toThrow();
  });
});
