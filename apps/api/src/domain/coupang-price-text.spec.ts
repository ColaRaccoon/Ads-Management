import { describe, expect, it } from "vitest";
import { CoupangPriceTextParser, legacyCoupangPriceTextItemName } from "./coupang-price-text";

describe("CoupangPriceTextParser", () => {
  const parser = new CoupangPriceTextParser();

  it("parses tab-separated won-prefixed prices from the sale price text file", () => {
    const parsed = parser.parseBuffer(
      Buffer.from(
        [
          "다이어트양말 10개입\t₩69,900",
          "이지드림안대 3d+3d\t₩38,800",
          "스포츠양말 7개입\t₩71,900"
        ].join("\n"),
        "utf8"
      )
    );

    expect(parsed.rows.map((row) => row.issues)).toEqual([[], [], []]);
    expect(parsed.rows.map((row) => row.parsedRow)).toEqual([
      { itemName: "다이어트양말 10개입", salePriceKrw: 69900 },
      { itemName: "이지드림안대 3d+3d", salePriceKrw: 38800 },
      { itemName: "스포츠양말 7개입", salePriceKrw: 71900 }
    ]);
  });

  it("keeps support for comma-delimited price text rows", () => {
    const parsed = parser.parseBuffer(Buffer.from("Product with number 2,19,800", "utf8"));

    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.rows[0].parsedRow).toEqual({ itemName: "Product with number 2", salePriceKrw: 19800 });
  });

  it("detects the product name produced by the legacy comma-based parser", () => {
    expect(legacyCoupangPriceTextItemName("다이어트양말 10개입\t₩69,900", "다이어트양말 10개입")).toBe(
      "다이어트양말 10개입\t₩69"
    );
    expect(legacyCoupangPriceTextItemName("Product,19800", "Product")).toBeNull();
  });
});
