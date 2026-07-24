import { describe, expect, it } from "vitest";
import { MAX_KRW_INTEGER, formatKrwInputValue, parseKrwIntegerInput } from "./krw-input";

describe("KRW integer input", () => {
  it.each([["12800", 12_800], ["12,800", 12_800], [" 12,800 ", 12_800], ["0", 0]])("parses %s", (raw, value) => {
    expect(parseKrwIntegerInput(raw)).toEqual({ kind: "valid", value });
  });
  it("keeps empty distinct from invalid", () => expect(parseKrwIntegerInput("")).toEqual({ kind: "empty" }));
  it.each(["12,800원", "12.5", "-1", "12a00", "1,23"])("rejects %s", (raw) => {
    expect(parseKrwIntegerInput(raw).kind).toBe("invalid");
  });
  it("rejects Decimal(14,2) overflow", () => {
    expect(parseKrwIntegerInput(String(MAX_KRW_INTEGER + 1)).kind).toBe("invalid");
  });
  it("formats valid values", () => {
    expect(formatKrwInputValue(12_800)).toBe("12,800");
    expect(formatKrwInputValue(null)).toBe("");
  });
});
