import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CoupangAdsXlsxParser } from "./coupang-ads-xlsx";
import { formatDateOnly } from "./date-number";

describe("CoupangAdsXlsxParser", () => {
  it("parses ad spend and conversion product names separately", async () => {
    const parser = new CoupangAdsXlsxParser();
    const buffer = await workbookBuffer([
      [
        "Date",
        "Campaign Name",
        "Ad Group",
        "Ad Execution Option ID",
        "Ad Execution Product Name",
        "Conversion Option ID",
        "Conversion Product Name",
        "Impressions",
        "Clicks",
        "Ad Spend(KRW)",
        "Total Orders(1d)",
        "Direct Orders(1d)",
        "Indirect Orders(1d)",
        "Total Conversion Sales(1d)(KRW)",
        "Direct Conversion Sales(1d)(KRW)",
        "Indirect Conversion Sales(1d)(KRW)",
        "Total Sales Quantity(1d)",
        "Direct Sales Quantity(1d)",
        "Indirect Sales Quantity(1d)"
      ],
      ["2026-06-23", "Campaign", "Group", "E-1", "Spend Product", "C-1", "Conversion Product", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2]
    ]);

    const parsed = await parser.parseBuffer(buffer);

    expect(parsed.missingColumns).toHaveLength(0);
    expect(parsed.rows[0].issues).toHaveLength(0);
    expect(parsed.rows[0].parsedRow?.adExecutionProductName).toBe("Spend Product");
    expect(parsed.rows[0].parsedRow?.conversionProductName).toBe("Conversion Product");
    expect(parsed.rows[0].parsedRow?.adSpendKrw).toBe(12_000);
    expect(parsed.rows[0].parsedRow?.metricDate ? formatDateOnly(parsed.rows[0].parsedRow.metricDate) : null).toBe("2026-06-23");
  });

  it("accepts compact YYYYMMDD dates exported by Coupang", async () => {
    const parser = new CoupangAdsXlsxParser();
    const buffer = await workbookBuffer([
      [
        "Date",
        "Campaign Name",
        "Ad Group",
        "Ad Execution Option ID",
        "Ad Execution Product Name",
        "Conversion Option ID",
        "Conversion Product Name",
        "Impressions",
        "Clicks",
        "Ad Spend(KRW)",
        "Total Orders(1d)",
        "Direct Orders(1d)",
        "Indirect Orders(1d)",
        "Total Conversion Sales(1d)(KRW)",
        "Direct Conversion Sales(1d)(KRW)",
        "Indirect Conversion Sales(1d)(KRW)",
        "Total Sales Quantity(1d)",
        "Direct Sales Quantity(1d)",
        "Indirect Sales Quantity(1d)"
      ],
      ["20260622", "Campaign", "Group", "E-1", "Spend Product", "C-1", "Conversion Product", 1000, 50, "12,000", 3, 2, 1, 90000, 60000, 30000, 4, 2, 2]
    ]);

    const parsed = await parser.parseBuffer(buffer);

    expect(parsed.rows[0].issues).toHaveLength(0);
    expect(parsed.rows[0].parsedRow?.metricDate ? formatDateOnly(parsed.rows[0].parsedRow.metricDate) : null).toBe("2026-06-22");
  });
});

async function workbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("ads");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
