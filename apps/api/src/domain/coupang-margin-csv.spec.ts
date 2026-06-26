import { describe, expect, it } from "vitest";
import { CoupangMarginCsvParser } from "./coupang-margin-csv";

describe("CoupangMarginCsvParser", () => {
  it("parses the Coupang margin input CSV columns", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "항목,원가,판매수수료율,하나로 배송비,그로스 입출고비,그로스 배송비",
      '구름깔창,"₩1,300",11.55%,₩650,"₩1,050","₩1,950"'
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.rows[0].parsedRow).toMatchObject({
      itemName: "구름깔창",
      ignoredSalePriceKrw: null,
      productCostKrw: 1300,
      sellerShippingFeeKrw: 650,
      growthInboundFeeKrw: 1050,
      growthShippingFeeKrw: 1950,
      returnCostPerUnitKrw: 0
    });
    expect(parsed.rows[0].parsedRow?.salesFeeRate).toBeCloseTo(0.1155);
  });

  it("keeps sale price only as an ignored audit value when present", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "Item,Sale Price,Product Cost,Sales Fee Rate,Seller Shipping Fee,Growth Inbound Fee,Growth Shipping Fee",
      "Zero Bar,24050,7000,10.8%,3000,500,1200"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].parsedRow?.ignoredSalePriceKrw).toBe(24050);
  });
});
