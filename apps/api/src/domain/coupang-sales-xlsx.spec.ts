import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CoupangSalesXlsxParser, extractDateFromFilename } from "./coupang-sales-xlsx";
import { formatDateOnly } from "./date-number";

describe("CoupangSalesXlsxParser", () => {
  it("parses sales rows and calculates default net sales by adding cancel amount", async () => {
    const parser = new CoupangSalesXlsxParser();
    const buffer = await workbookBuffer([
      [
        "Option ID",
        "Option Name",
        "Product Name",
        "Sale Method",
        "Sales(KRW)",
        "Orders",
        "Sales Quantity",
        "Total Sales(KRW)",
        "Total Sales Quantity",
        "Cancel Amount(KRW)",
        "Cancel Quantity",
        "Instant Cancel Quantity"
      ],
      ["A-1", "Black", "Zero Bar", "seller", "100,000", 3, 4, 120000, 5, "-10,000", 1, 0]
    ]);

    const parsed = await parser.parseBuffer(buffer, { reportDate: "2026-06-23" });

    expect(parsed.missingColumns).toHaveLength(0);
    expect(parsed.rows[0].issues).toHaveLength(0);
    expect(parsed.rows[0].parsedRow?.netSalesKrw).toBe(90_000);
    expect(parsed.rows[0].parsedRow?.salesQuantity).toBe(4);
  });

  it("accepts actual Coupang sales headers and falls back to YYMMDD filename dates", async () => {
    const parser = new CoupangSalesXlsxParser();
    const buffer = await workbookBuffer([
      [
        "옵션 ID",
        "옵션명",
        "상품명",
        "등록상품ID",
        "판매방식",
        "매출(원)",
        "주문",
        "판매량",
        "총 매출(원)",
        "총 판매수",
        "총 취소 금액(원)",
        "총 취소된 상품수",
        "즉시 취소된 상품수"
      ],
      ["A-1", "블랙", "제로바", "P-1", "seller", "100,000", 3, 4, 120000, 5, "-10,000", 1, 0]
    ]);

    const parsed = await parser.parseBuffer(buffer, { filename: "260622.xlsx" });

    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows[0].issues).toHaveLength(0);
    expect(parsed.rows[0].parsedRow?.registeredProductId).toBe("P-1");
    expect(parsed.rows[0].parsedRow?.saleDate ? formatDateOnly(parsed.rows[0].parsedRow.saleDate) : null).toBe("2026-06-22");
    expect(extractDateFromFilename("260622.xlsx")).toBe("2026-06-22");
  });
});

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
