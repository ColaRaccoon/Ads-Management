import { describe, expect, it } from "vitest";
import { CoupangMarginCsvParser } from "./coupang-margin-csv";

describe("CoupangMarginCsvParser", () => {
  it("parses the Coupang margin input CSV columns", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "항목,판매가(VAT포함),원가,판매수수료율,하나로 배송비,그로스 입출고비,그로스 배송비",
      '구름깔창,"₩24,050","₩1,300",11.55%,₩650,"₩1,050","₩1,950"'
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.rows[0].parsedRow).toMatchObject({
      itemName: "구름깔창",
      salePriceKrw: 24050,
      productCostKrw: 1300,
      sellerShippingFeeKrw: 650,
      growthInboundFeeKrw: 1050,
      growthShippingFeeKrw: 1950,
      returnCostPerUnitKrw: 0
    });
    expect(parsed.rows[0].parsedRow?.salesFeeRate).toBeCloseTo(0.1155);
  });

  it("stores sale price as salePriceKrw when present", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "Item,Sale Price,Product Cost,Sales Fee Rate,Seller Shipping Fee,Growth Inbound Fee,Growth Shipping Fee",
      "Zero Bar,24050,7000,10.8%,3000,500,1200"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].parsedRow?.salePriceKrw).toBe(24050);
  });

  it("parses the current tab-separated margin input sheet", () => {
    const parser = new CoupangMarginCsvParser();
    const tsv = [
      "항목\t판매가(VAT포함)\t원가\t판매수수료율\t하나로 배송비\t그로스 입출고비\t그로스 배송비",
      "다이어트양말 10개입\t₩69,900\t₩20,000\t11.88%\t₩500\t₩1,650\t₩2,200"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(tsv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.rows[0].parsedRow).toMatchObject({
      itemName: "다이어트양말 10개입",
      salePriceKrw: 69900,
      productCostKrw: 20000,
      sellerShippingFeeKrw: 500,
      growthInboundFeeKrw: 1650,
      growthShippingFeeKrw: 2200,
      returnCostPerUnitKrw: 0
    });
    expect(parsed.rows[0].parsedRow?.salesFeeRate).toBeCloseTo(0.1188);
  });
});
