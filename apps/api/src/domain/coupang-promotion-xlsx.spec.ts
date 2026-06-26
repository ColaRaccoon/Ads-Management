import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CoupangPromotionXlsxParser } from "./coupang-promotion-xlsx";
import { formatDateOnly } from "./date-number";

describe("CoupangPromotionXlsxParser", () => {
  it("parses promotion rows with Coupang date-time text", async () => {
    const parser = new CoupangPromotionXlsxParser();
    const buffer = await workbookBuffer([
      [
        "ID",
        "Product Name",
        "Option Name",
        "Option ID",
        "Sale Price",
        "Promotion Price",
        "Promotion Quantity",
        "Shipping Type",
        "Promotion Status",
        "Start Date",
        "End Date",
        "Exposure Area",
        "Sales Amount",
        "Impressions",
        "Order Quantity",
        "Sale Method",
        "Requested At"
      ],
      [
        "promo-1",
        "Zero Bar",
        "Black 2-pack",
        "option-1",
        "25,800",
        "24,050",
        10,
        "free",
        "running",
        "2026.06.19(금) 00:00",
        "2026.07.19(일) 00:00",
        "search",
        "120,000",
        "1,234",
        5,
        "rocket growth",
        "2026.06.18(목) 12:30"
      ]
    ]);

    const parsed = await parser.parseBuffer(buffer);
    const row = parsed.rows[0].parsedRow;

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toEqual([]);
    expect(row?.productText).toBe("Zero Bar Black 2-pack");
    expect(row?.promotionPriceKrw).toBe(24050);
    expect(row?.promotionStartDate ? formatDateOnly(row.promotionStartDate) : null).toBe("2026-06-19");
    expect(row?.promotionEndDate ? formatDateOnly(row.promotionEndDate) : null).toBe("2026-07-19");
  });

  it("supports actual Coupang combined product and option header", async () => {
    const parser = new CoupangPromotionXlsxParser();
    const buffer = await workbookBuffer([
      ["ID", "등록상품명, 옵션명", "프로모션 가격", "프로모션 상태", "시작일시", "종료일시"],
      ["promo-1", "인피니티 베개 무릎보호대,블랙 1개 L", "24,050", "진행중", "2026.06.19(금) 00:00", "2026.07.19(일) 00:00"]
    ]);

    const parsed = await parser.parseBuffer(buffer);
    const row = parsed.rows[0].parsedRow;

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toEqual([]);
    expect(row?.productText).toBe("인피니티 베개 무릎보호대,블랙 1개 L");
    expect(row?.rawProductName).toBe("인피니티 베개 무릎보호대");
    expect(row?.rawOptionName).toBe("블랙 1개 L");
    expect(row?.promotionPriceKrw).toBe(24050);
  });

  it("reports missing required columns", async () => {
    const parser = new CoupangPromotionXlsxParser();
    const buffer = await workbookBuffer([["Product Name", "Option Name"], ["Zero Bar", "Black"]]);

    const parsed = await parser.parseBuffer(buffer);

    expect(parsed.missingColumns).toEqual(["promotionPriceKrw", "promotionStartDate", "promotionEndDate"]);
  });

  it("rejects inverted promotion date ranges", async () => {
    const parser = new CoupangPromotionXlsxParser();
    const buffer = await workbookBuffer([
      ["Product Name", "Option Name", "Promotion Price", "Start Date", "End Date"],
      ["Zero Bar", "Black", 24050, "2026-07-19", "2026-06-19"]
    ]);

    const parsed = await parser.parseBuffer(buffer);

    expect(parsed.rows[0].parsedRow).toBeNull();
    expect(parsed.rows[0].issues.map((issue) => issue.errorCode)).toContain("INVALID_PROMOTION_DATE_RANGE");
  });
});

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("promotions");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
