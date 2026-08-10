import { describe, expect, it } from "vitest";
import {
  buildMetaDailyXlsxInput,
  buildMetaDailyXlsxWorkbook,
  type MetaDailyCreativeRow,
  type MetaDailySalesRow,
  type MetaDailyXlsxReport
} from "./meta-daily-xlsx";
import type { XlsxCell, XlsxRow } from "./xlsx";
import { META_DAILY_COLUMNS } from "./meta-daily-columns";

describe("Meta daily XLSX builder", () => {
  it("keeps only the visible current-day Meta columns and values", () => {
    const rows = buildMetaDailyXlsxInput(reportFixture()).rows;
    const creativeHeaders = rowCells(rows[4]);
    const creative = rowCells(rows[5]);

    expect(creativeHeaders.slice(0, 5).map((cell) => cell.value)).toEqual([
      "소재",
      "활성상태",
      "광고비 USD",
      "CTR",
      "ROAS"
    ]);
    expect(creative[0]).toMatchObject({
      value: "여름 소재 07",
      style: "Text",
      fill: "GROUP_MINT"
    });
    expect(creative[0]?.value).not.toContain("M-07");
    expect(creative[1]).toMatchObject({ value: "활성", style: "Text" });
    expect(creative[2]).toMatchObject({ value: 120.5, style: "Usd" });
    expect(creative[3]).toMatchObject({ value: 0.0345, style: "Percent" });
    expect(creative[4]).toMatchObject({ value: 2.2, style: "Percent" });
    expect(creative.slice(5).every((cell) => cell.fill === "GROUP_MINT")).toBe(true);
    expect(creativeHeaders.some((cell) => String(cell.value).includes("전일"))).toBe(false);
  });

  it("bounds a full current-day export at column M with no residual cells on the right", () => {
    const report = reportFixture();
    report.visibleColumns = [
      "creative",
      "status",
      "dataDays",
      "spendUsd",
      "spendKrw",
      "purchaseCount",
      "cpa",
      "ctr",
      "cpm",
      "roas"
    ];
    const input = buildMetaDailyXlsxInput(report);
    const headers = rowCells(input.rows[4]);
    const data = rowCells(input.rows[5]);

    expect(headers).toHaveLength(13);
    expect(data).toHaveLength(13);
    expect(headers.slice(0, 10).map((cell) => cell.value)).toEqual([
      "소재",
      "활성상태",
      "집계일수",
      "광고비 USD",
      "광고비 KRW",
      "구매건수",
      "CPA",
      "CTR",
      "CPM",
      "ROAS"
    ]);
    expect(headers.slice(10).every((cell) => cell.value === "")).toBe(true);
    expect(input.columns).toHaveLength(13);

    const sheet = readZipText(
      buildMetaDailyXlsxWorkbook(report),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheet).toContain(`<dimension ref="A1:M16"/>`);
    expect(sheet).not.toMatch(/<c r="[N-Z]\d+"/);
  });

  it("builds contiguous colored product blocks with product, sales, and note values", () => {
    const input = buildMetaDailyXlsxInput(reportFixture());
    const rows = input.rows;

    expect(rowCells(rows[0])[0]).toMatchObject({
      value: "Meta Daily Report · 기준일 2026-08-03",
      fill: "REPORT_HEADER",
      fontTone: "INVERSE",
      bold: true
    });
    expect(rowCells(rows[2]).slice(0, 6).map((cell) => cell.value)).toEqual([
      2,
      120.5,
      165_000,
      3,
      55_000,
      2.2
    ]);

    const firstProduct = rowCells(rows[3]);
    expect(firstProduct[0]).toMatchObject({ value: "웨이브바", fill: "GROUP_MINT", bold: true });
    expect(firstProduct[2]).toMatchObject({ value: 1, style: "Number" });
    expect(firstProduct[4]).toMatchObject({ value: 120.5, style: "Usd" });
    expect(firstProduct[6]).toMatchObject({ value: 165_000, style: "Krw" });
    expect(firstProduct[10]).toMatchObject({ value: 55_000, style: "Krw" });
    expect(firstProduct[12]).toMatchObject({ value: 2.2, style: "Percent" });

    expect(rowCells(rows[6])[0]).toMatchObject({
      value: "카페24 실매출 기반 마진",
      fill: "GROUP_MINT",
      bold: true
    });
    const sales = rowCells(rows[8]);
    expect(sales[0]).toMatchObject({ value: "웨이브바\n판매 행 2", wrapText: true });
    expect(sales[1]).toMatchObject({ value: 3, style: "Number" });
    expect(sales[2]).toMatchObject({ value: 297_000, style: "Krw" });
    expect(sales[8]).toMatchObject({ value: 57_000, fontTone: "POSITIVE" });
    expect(sales[9]).toMatchObject({ value: 47_000, fontTone: "POSITIVE" });
    expect(sales[10]).toMatchObject({ value: 0.1582, style: "Percent" });
    expect(rowCells(rows[9])[0]?.value).toBe(
      "쿠폰 적용 2건 · 정확 1건 · 추정 1건 · 무시 잔여 500원"
    );
    expect(rowCells(rows[10])[0]?.value).toBe(
      "광고 수정 기록 · 2026-08-03 웨이브바에 등록된 기록이 없습니다."
    );

    const secondProduct = rowCells(rows[11]);
    expect(secondProduct[0]).toMatchObject({ value: "판매 전용 상품", fill: "GROUP_BLUE" });
    expect(rowCells(rows[12])[0]).toMatchObject({
      value: "표시할 Meta 소재가 없습니다.",
      fill: "GROUP_BLUE"
    });
    expect(rowCells(rows[14])[0]?.value).toBe("매칭되는 카페24 실매출 데이터가 없습니다.");
    expect(input.freezeRow).toBe(3);
    expect(input.columns).toHaveLength(13);
    expect(input.merges).toEqual(expect.arrayContaining([
      { fromRow: 1, fromColumn: 1, toRow: 1, toColumn: 13 },
      { fromRow: 7, fromColumn: 1, toRow: 7, toColumn: 13 },
      { fromRow: 10, fromColumn: 1, toRow: 10, toColumn: 13 },
      { fromRow: 13, fromColumn: 1, toRow: 13, toColumn: 13 },
      { fromRow: 15, fromColumn: 1, toRow: 15, toColumn: 13 }
    ]));
  });

  it("expands beyond the legacy width and writes reach plus five video percentages", () => {
    const report = reportFixture();
    report.visibleColumns = META_DAILY_COLUMNS.map((column) => column.key);
    const input = buildMetaDailyXlsxInput(report);
    const headers = rowCells(input.rows[4]);
    const data = rowCells(input.rows[5]);

    expect(input.columns).toHaveLength(16);
    expect(headers).toHaveLength(16);
    expect(headers.slice(9, 15).map((cell) => cell.value)).toEqual([
      "도달",
      "3초 재생률",
      "25% 재생률",
      "50% 재생률",
      "75% 재생률",
      "100% 재생률"
    ]);
    expect(headers[15]).toMatchObject({ value: "ROAS" });
    expect(data[9]).toMatchObject({ value: 84, style: "Number" });
    expect(data[10]).toMatchObject({ value: 41 / 84, style: "Percent" });
    expect(data[11]).toMatchObject({ value: 8 / 84, style: "Percent" });
    expect(data[15]).toMatchObject({ value: 2.2, style: "Percent" });
    expect(input.merges).toContainEqual({ fromRow: 1, fromColumn: 1, toRow: 1, toColumn: 16 });

    const sheet = readZipText(buildMetaDailyXlsxWorkbook(report), "xl/worksheets/sheet1.xml");
    expect(sheet).toContain(`<dimension ref="A1:P16"/>`);
    expect(sheet).toMatch(/<c r="K6" s="\d+"><v>0\.4880952380952381<\/v><\/c>/);
  });

  it("writes valid OOXML with the same four product-band colors used by Coupang", () => {
    const report = reportFixture();
    const paletteReport = {
      ...report,
      groups: Array.from({ length: 5 }, (_, index) => ({
        ...report.groups[1],
        productName: `색상 상품 ${index + 1}`,
        productId: `palette-${index + 1}`
      }))
    };
    const paletteInput = buildMetaDailyXlsxInput(paletteReport);
    expect([3, 8, 13, 18, 23].map((rowIndex) => rowCells(paletteInput.rows[rowIndex])[0]?.fill)).toEqual([
      "GROUP_MINT",
      "GROUP_BLUE",
      "GROUP_SAND",
      "GROUP_LILAC",
      "GROUP_MINT"
    ]);

    const styles = readZipText(buildMetaDailyXlsxWorkbook(paletteReport), "xl/styles.xml");
    const sheet = readZipText(buildMetaDailyXlsxWorkbook(report), "xl/worksheets/sheet1.xml");

    for (const color of ["FFE7F3EF", "FFEAF2FB", "FFFBF1DF", "FFF1ECF8"]) {
      expect(styles).toContain(`rgb="${color}"`);
    }
    expect(sheet).toContain(`<dimension ref="A1:M16"/>`);
    expect(sheet).toContain(`<pane ySplit="3" topLeftCell="A4"`);
    expect(sheet).toContain(`<mergeCell ref="A1:M1"/>`);
    expect(sheet).toMatch(/<c r="C6" s="\d+"><v>120\.5<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="D6" s="\d+"><v>0\.0345<\/v><\/c>/);
    expect(sheet).not.toMatch(/<c r="(?:C6|D6)"[^>]*t="inlineStr"/);
    expect(sheet).not.toContain("전일");
  });
});

function reportFixture(): MetaDailyXlsxReport {
  const current = creativeRow();
  const totals = {
    spendUsd: 120.5,
    spendKrw: 165_000,
    purchaseCount: 3,
    cpaUsd: 40.166666,
    cpaKrw: 55_000,
    revenueKrw: 363_000,
    roas: 2.2
  };

  return {
    reportDate: "2026-08-03",
    productCount: 2,
    totals,
    visibleColumns: ["creative", "status", "spendUsd", "ctr", "roas"],
    groups: [
      {
        productName: "웨이브바",
        productId: "product-1",
        rows: [current],
        totals,
        salesRow: salesRow()
      },
      {
        productName: "판매 전용 상품",
        productId: "product-2",
        rows: [],
        totals: {
          spendUsd: 0,
          spendKrw: 0,
          purchaseCount: 0,
          cpaUsd: null,
          cpaKrw: null,
          revenueKrw: 0,
          roas: null
        },
        salesRow: null
      }
    ]
  };
}

function creativeRow(overrides: Partial<MetaDailyCreativeRow> = {}): MetaDailyCreativeRow {
  return {
    creativeKey: "creative-1",
    displayName: "여름 소재 07",
    productName: "웨이브바",
    productId: "product-1",
    materialNo: "M-07",
    deliveryStatus: "active",
    totals: {
      spendUsd: 120.5,
      spendKrw: 165_000,
      purchaseCount: 3,
      cpaUsd: 40.166666,
      cpaKrw: 55_000,
      ctrLinkPct: 3.45,
      cpmUsd: 14.2,
      roas: 2.2,
      revenueKrw: 363_000,
      reach: 84,
      videoPlay3sCount: 41,
      videoPlay25Count: 8,
      videoPlay50Count: 5,
      videoPlay75Count: 2,
      videoPlay100Count: 2,
      videoPlay3sRatePct: 41 / 84 * 100,
      videoPlay25RatePct: 8 / 84 * 100,
      videoPlay50RatePct: 5 / 84 * 100,
      videoPlay75RatePct: 2 / 84 * 100,
      videoPlay100RatePct: 2 / 84 * 100
    },
    dataDays: 1,
    ...overrides
  };
}

function salesRow(): MetaDailySalesRow {
  return {
    productId: "product-1",
    product: { displayName: "웨이브바" },
    quantity: 3,
    revenueKrw: 297_000,
    totalPaidKrw: 287_000,
    adSpendUsd: 120.5,
    adSpendKrw: 165_000,
    grossCostKrw: 65_000,
    totalCostKrw: 240_000,
    marginBeforeCouponKrw: 57_000,
    couponDeductionKrw: 10_000,
    marginKrw: 47_000,
    marginRate: 0.1582,
    matchedSalesLineCount: 2,
    couponOrderCount: 2,
    couponExactOrderCount: 1,
    couponEstimatedOrderCount: 1,
    couponUnmatchedOrderCount: 0,
    couponIgnoredResidualKrw: 500
  };
}

function rowCells(row: XlsxCell[] | XlsxRow | undefined) {
  if (!row) throw new Error("Missing XLSX row.");
  return Array.isArray(row) ? row : row.cells;
}

function readZipText(workbook: Uint8Array, entryName: string) {
  const decoder = new TextDecoder();
  const view = new DataView(workbook.buffer, workbook.byteOffset, workbook.byteLength);
  let offset = 0;

  while (offset + 30 <= workbook.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const fileNameStart = offset + 30;
    const contentStart = fileNameStart + fileNameLength + extraLength;
    const name = decoder.decode(workbook.subarray(fileNameStart, fileNameStart + fileNameLength));
    if (name === entryName) {
      return decoder.decode(workbook.subarray(contentStart, contentStart + compressedSize));
    }
    offset = contentStart + compressedSize;
  }

  throw new Error(`ZIP entry not found: ${entryName}`);
}
