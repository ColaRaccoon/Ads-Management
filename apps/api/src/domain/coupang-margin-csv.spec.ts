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
      hanaroShippingFeeKrw: 650,
      growthInboundFeeKrw: 1050,
      growthShippingFeeKrw: 1950,
      returnCostPerUnitKrw: 0
    });
    expect(parsed.ignoredColumns).toEqual(["판매수수료율"]);
  });

  it("stores sale price as salePriceKrw when present", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "Item,Sale Price,Product Cost,Sales Fee Rate,Hanaro Shipping Fee,Seller Shipping Fee,Growth Inbound Fee,Growth Shipping Fee",
      "Zero Bar,24050,7000,10.8%,650,3000,500,1200"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].parsedRow?.salePriceKrw).toBe(24050);
    expect(parsed.rows[0].parsedRow?.hanaroShippingFeeKrw).toBe(650);
    expect(parsed.rows[0].parsedRow?.sellerShippingFeeKrw).toBe(3000);
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
      hanaroShippingFeeKrw: 500,
      growthInboundFeeKrw: 1650,
      growthShippingFeeKrw: 2200,
      returnCostPerUnitKrw: 0
    });
    expect(parsed.ignoredColumns).toEqual(["판매수수료율"]);
    expect(parsed.rows[0].parsedRow?.sellerShippingFeeKrw).toBeUndefined();
  });

  it("keeps an empty optional seller shipping cell distinct from an explicit zero", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "항목,판매가,원가,판매수수료율,하나로 배송비,판매자 배송비,그로스 입출고비,그로스 배송비",
      "빈값,10000,3000,10%,300,,200,900",
      "명시적0,10000,3000,10%,300,0,200,900"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].parsedRow?.sellerShippingFeeKrw).toBeUndefined();
    expect(parsed.rows[0].parsedRow?.hanaroShippingFeeKrw).toBe(300);
    expect(parsed.rows[1].parsedRow?.sellerShippingFeeKrw).toBe(0);
  });

  it("keeps a blank Hanaro shipping cell as null", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "Item,Sale Price,Product Cost,Sales Fee Rate,Hanaro Shipping Fee,Growth Inbound Fee,Growth Shipping Fee",
      "Blank Hanaro,10000,3000,10%,,200,900"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.rows[0].parsedRow?.hanaroShippingFeeKrw).toBeNull();
  });

  it("accepts a margin file with no legacy sales-fee columns", () => {
    const parser = new CoupangMarginCsvParser();
    const csv = [
      "Item,Sale Price,Product Cost,Hanaro Shipping Fee,Growth Inbound Fee,Growth Shipping Fee",
      "Global Fee Product,10000,3000,400,200,900"
    ].join("\n");

    const parsed = parser.parseBuffer(Buffer.from(csv, "utf8"));

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.rows[0].parsedRow).toMatchObject({ itemName: "Global Fee Product", productCostKrw: 3000 });
  });

  it.each([
    ["Seller Shipping Fee", "not-a-number"],
    ["Seller Shipping Fee", "-1"],
    ["Seller Shipping Fee", "1.5"],
    ["Seller Shipping Fee", "NaN"],
    ["Seller Shipping Fee", "Infinity"],
    ["Hanaro Shipping Fee", "not-a-number"],
    ["Hanaro Shipping Fee", "-1"],
    ["Hanaro Shipping Fee", "1.5"],
    ["Hanaro Shipping Fee", "NaN"],
    ["Hanaro Shipping Fee", "Infinity"],
    ["Growth Inbound Fee", "not-a-number"],
    ["Growth Inbound Fee", "-1"],
    ["Growth Inbound Fee", "1.5"],
    ["Growth Inbound Fee", "NaN"],
    ["Growth Inbound Fee", "Infinity"],
    ["Growth Shipping Fee", "not-a-number"],
    ["Growth Shipping Fee", "-1"],
    ["Growth Shipping Fee", "1.5"],
    ["Growth Shipping Fee", "NaN"],
    ["Growth Shipping Fee", "Infinity"]
  ])("rejects invalid logistics value %s=%s", (column, invalidValue) => {
    const parser = new CoupangMarginCsvParser();
    const headers = [
      "Item",
      "Sale Price",
      "Product Cost",
      "Sales Fee Rate",
      "Seller Shipping Fee",
      "Hanaro Shipping Fee",
      "Growth Inbound Fee",
      "Growth Shipping Fee"
    ];
    const values = ["Invalid Logistics", "10000", "3000", "10%", "300", "400", "200", "900"];
    values[headers.indexOf(column)] = invalidValue;
    const parsed = parser.parseBuffer(Buffer.from([headers.join(","), values.join(",")].join("\n"), "utf8"));

    expect(parsed.rows[0].parsedRow).toBeNull();
    expect(parsed.rows[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: "INVALID_NON_NEGATIVE_INTEGER", rawValue: invalidValue })
    ]));
  });
});
