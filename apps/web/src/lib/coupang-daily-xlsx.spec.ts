import { describe, expect, it } from "vitest";
import type { CoupangDailyExportRow } from "./coupang-daily-report";
import {
  buildCoupangDailyXlsxInput,
  buildCoupangDailyXlsxWorkbook,
  classifyDailySalesQuantityHighlight,
  COUPANG_DAILY_XLSX_COLUMNS,
  filterCoupangDailyXlsxRows
} from "./coupang-daily-xlsx";
import type { XlsxCell, XlsxRow } from "./xlsx";

const total = exportRow({
  rowKind: "전체합계",
  productName: "전체 합계",
  reportedSalesQuantity: 94,
  previousReportedSalesQuantity: 81,
  visualBlockKey: null,
  visualBlockIndex: null
});
const group = exportRow({
  rowKind: "그룹합계",
  productName: "웨이브 밸런스바",
  reportedSalesQuantity: 34,
  previousReportedSalesQuantity: 20,
  manualPurchaseQuantity: 3,
  previousManualPurchaseQuantity: 0,
  visualBlockKey: "group:wavebar",
  visualBlockIndex: 0,
  visualChildProductCount: 2
});
const increasedOption = exportRow({
  rowKind: "옵션",
  productName: "블랙",
  reportedSalesQuantity: 30,
  previousReportedSalesQuantity: 15,
  manualPurchaseQuantity: 3,
  previousManualPurchaseQuantity: 0,
  visualBlockKey: "group:wavebar",
  visualBlockIndex: 0,
  indentLevel: 1,
  roas: 2.083,
  marginKrw: 20_000,
  previousMarginKrw: -5_000
});
const tenDecreaseOption = exportRow({
  rowKind: "옵션",
  productName: "베이지",
  reportedSalesQuantity: 10,
  previousReportedSalesQuantity: 20,
  manualPurchaseQuantity: 0,
  previousManualPurchaseQuantity: 0,
  visualBlockKey: "group:wavebar",
  visualBlockIndex: 0,
  indentLevel: 1
});
const groupNote = noteRow({
  productName: "기타사항: 블랙 리뷰 보강",
  visualBlockKey: "group:wavebar",
  visualBlockIndex: 0
});
const decreasedSingle = exportRow({
  rowKind: "단일제품",
  productName: "논슬립 슬라이드 매트",
  reportedSalesQuantity: 10,
  previousReportedSalesQuantity: 20,
  manualPurchaseQuantity: 0,
  previousManualPurchaseQuantity: 0,
  visualBlockKey: "product:mat",
  visualBlockIndex: 1,
  marginKrw: -12_000,
  previousMarginKrw: 7_000
});
const singleNote = noteRow({
  productName: "기타사항: 신규 상품 체험단",
  visualBlockKey: "product:mat",
  visualBlockIndex: 1
});

describe("Coupang daily XLSX builder", () => {
  it("uses the exact eleven report columns and widths", () => {
    expect(COUPANG_DAILY_XLSX_COLUMNS.map((column) => column.header)).toEqual([
      "제품명",
      "매출",
      "직전 기간 매출",
      "판매수",
      "직전 기간 판매수",
      "가구매 수",
      "광고비",
      "광고수익률(집행상품 기준)",
      "오가닉매출(판매상품 기준)",
      "최종순이익",
      "직전 기간 최종 순이익"
    ]);
    expect(COUPANG_DAILY_XLSX_COLUMNS.map((column) => column.width)).toEqual([
      34, 16, 17, 11, 15, 12, 16, 25, 25, 18, 20
    ]);
    expect(COUPANG_DAILY_XLSX_COLUMNS.map((column) => column.style)).toEqual([
      "Text", "Krw", "Krw", "Number", "Number", "Number", "Krw", "Percent1", "Krw", "Krw", "Krw"
    ]);
  });

  it("keeps totals and colored product blocks contiguous with hierarchy styling", () => {
    const input = buildCoupangDailyXlsxInput([
      total,
      group,
      increasedOption,
      tenDecreaseOption,
      groupNote,
      decreasedSingle,
      singleNote
    ]);
    const rows = input.rows;

    expect(rows).toHaveLength(8);
    expect(rowCells(rows[0])[0]).toMatchObject({
      value: "제품명",
      fill: "REPORT_HEADER",
      fontTone: "INVERSE",
      bold: true
    });
    expect(rowCells(rows[1])[0]).toMatchObject({
      value: "전체 합계",
      fill: "REPORT_TOTAL",
      bold: true
    });
    const groupRow = rowCells(rows[2]);
    const firstOptionRow = rowCells(rows[3]);
    const secondOptionRow = rowCells(rows[4]);
    const note = rowCells(rows[5]);
    expect(groupRow[0]).toMatchObject({
      value: "Σ 웨이브 밸런스바 (그룹 합계 · 옵션 2개)",
      fill: "GROUP_MINT",
      bold: true,
      borderTone: "BLOCK_START"
    });
    expect(firstOptionRow[0]).toMatchObject({
      value: "블랙",
      fill: "GROUP_MINT",
      bold: false,
      indent: 1
    });
    expect(secondOptionRow[0]?.fill).toBe("GROUP_MINT");
    expect(note).toHaveLength(11);
    expect(note[0]).toMatchObject({
      value: "기타사항: 블랙 리뷰 보강",
      fill: "GROUP_MINT",
      fontTone: "DEFAULT",
      wrapText: true,
      borderTone: "MERGED_START"
    });
    expect(note.slice(1, -1).every((cell) =>
      cell.value === "" &&
      cell.fill === "GROUP_MINT" &&
      cell.fontTone === "DEFAULT" &&
      cell.borderTone === "MERGED_MIDDLE"
    )).toBe(true);
    expect(note.at(-1)).toMatchObject({
      value: "",
      fill: "GROUP_MINT",
      fontTone: "DEFAULT",
      borderTone: "MERGED_END"
    });
    expect(rowObject(rows[5]).height).toBeGreaterThanOrEqual(42);
    expect(rowCells(rows[6])[0]).toMatchObject({
      value: "논슬립 슬라이드 매트",
      fill: "GROUP_BLUE",
      bold: true,
      borderTone: "BLOCK_START"
    });
    expect(rowCells(rows[7])[0]?.fill).toBe("GROUP_BLUE");
    expect(rows.every((row) => Array.isArray(row) || row.height !== 6)).toBe(true);
    expect(input.merges).toEqual([
      { fromRow: 6, fromColumn: 1, toRow: 6, toColumn: 11 },
      { fromRow: 8, fromColumn: 1, toRow: 8, toColumn: 11 }
    ]);
    expect(input.freezeRow).toBe(1);
    expect(input.autoFilter).toEqual({ fromRow: 1, toRow: 8 });
  });

  it("applies sales highlights only to current quantity while retaining numeric formats and profit tones", () => {
    const rows = buildCoupangDailyXlsxInput([
      total,
      group,
      increasedOption,
      tenDecreaseOption,
      groupNote,
      decreasedSingle,
      singleNote
    ]).rows;

    const totalCells = rowCells(rows[1]);
    const groupCells = rowCells(rows[2]);
    const increaseCells = rowCells(rows[3]);
    const tenDecreaseCells = rowCells(rows[4]);
    const noteCells = rowCells(rows[5]);
    const decreaseCells = rowCells(rows[6]);

    expect(totalCells[3]).toMatchObject({ fill: "REPORT_TOTAL", style: "Number" });
    expect(groupCells[3]).toMatchObject({
      value: 34,
      style: "Number",
      fill: "SALES_INCREASE",
      fontTone: "INCREASE",
      bold: true,
      borderTone: "INCREASE"
    });
    expect(groupCells[4]).toMatchObject({ value: 20, fill: "GROUP_MINT", style: "Number" });
    expect(increaseCells[3]).toMatchObject({
      value: 30,
      style: "Number",
      fill: "SALES_INCREASE",
      fontTone: "INCREASE"
    });
    expect(increaseCells[4]).toMatchObject({ value: 15, fill: "GROUP_MINT" });
    expect(tenDecreaseCells[3]).toMatchObject({
      value: 10,
      fill: "SALES_DECREASE",
      fontTone: "DECREASE",
      bold: true,
      borderTone: "DECREASE"
    });
    expect(noteCells).toHaveLength(11);
    expect(noteCells[0]).toMatchObject({
      value: "기타사항: 블랙 리뷰 보강",
      fill: "GROUP_MINT",
      fontTone: "DEFAULT",
      wrapText: true
    });
    expect(noteCells.slice(1).every((cell) =>
      cell.value === "" &&
      cell.fill === "GROUP_MINT" &&
      cell.fontTone === "DEFAULT"
    )).toBe(true);
    expect(decreaseCells[3]).toMatchObject({
      value: 10,
      style: "Number",
      fill: "SALES_DECREASE",
      fontTone: "DECREASE",
      bold: true,
      borderTone: "DECREASE"
    });
    expect(increaseCells[9]?.fontTone).toBe("POSITIVE");
    expect(increaseCells[10]?.fontTone).toBe("NEGATIVE");
    expect(decreaseCells[9]?.fontTone).toBe("NEGATIVE");
    expect(decreaseCells[10]?.fontTone).toBe("POSITIVE");
    expect(increaseCells[6]).toMatchObject({ value: 128_000, style: "Krw" });
    expect(increaseCells[7]).toMatchObject({ value: 2.083, style: "Percent1" });
  });

  it("cycles the four product palettes by visible block order", () => {
    const rows = [
      exportRow({ productName: "A", visualBlockKey: "product:a", visualBlockIndex: 0 }),
      exportRow({ productName: "B", visualBlockKey: "product:b", visualBlockIndex: 1 }),
      exportRow({ productName: "C", visualBlockKey: "product:c", visualBlockIndex: 2 }),
      exportRow({ productName: "D", visualBlockKey: "product:d", visualBlockIndex: 3 }),
      exportRow({ productName: "E", visualBlockKey: "product:e", visualBlockIndex: 4 })
    ];
    const dataRows = buildCoupangDailyXlsxInput(rows).rows
      .filter((row) => Array.isArray(row))
      .slice(1)
      .map((row) => rowCells(row)[0]?.fill);

    expect(dataRows).toEqual([
      "GROUP_MINT",
      "GROUP_BLUE",
      "GROUP_SAND",
      "GROUP_LILAC",
      "GROUP_MINT"
    ]);

    const styles = readZipText(
      buildCoupangDailyXlsxWorkbook(rows),
      "xl/styles.xml"
    );
    for (const color of ["FFE7F3EF", "FFEAF2FB", "FFFBF1DF", "FFF1ECF8"]) {
      expect(styles).toContain(`rgb="${color}"`);
    }
  });

  it("writes contiguous valid OOXML with static colors, indentation, and numeric cells", () => {
    const workbook = buildCoupangDailyXlsxWorkbook([
      total,
      group,
      increasedOption,
      tenDecreaseOption,
      groupNote,
      decreasedSingle,
      singleNote
    ]);
    const styles = readZipText(workbook, "xl/styles.xml");
    const sheet = readZipText(workbook, "xl/worksheets/sheet1.xml");

    for (const color of [
      "FF385951",
      "FFEDF1F0",
      "FFE7F3EF",
      "FFEAF2FB",
      "FFDCECFF",
      "FFFFF2CC",
      "FF1557A0",
      "FF7A5A00",
      "FF13744A",
      "FFB5473B"
    ]) {
      expect(styles).toContain(`rgb="${color}"`);
    }
    expect(styles).toContain(`formatCode="0.0%"`);
    expect(styles).toContain(`<alignment horizontal="left" indent="1"/>`);
    expect(styles).toContain(`<alignment wrapText="1"/>`);
    expect(sheet).toContain(`<dimension ref="A1:K8"/>`);
    expect(sheet).not.toContain(`ht="6" customHeight="1"`);
    expect(sheet.match(/<row r="\d+"/g)).toEqual([
      `<row r="1"`,
      `<row r="2"`,
      `<row r="3"`,
      `<row r="4"`,
      `<row r="5"`,
      `<row r="6"`,
      `<row r="7"`,
      `<row r="8"`
    ]);
    expect(sheet).toMatch(/<row r="6" ht="\d+" customHeight="1">/);
    expect(sheet).toContain(`<autoFilter ref="A1:K8"/>`);
    expect(sheet).toContain(
      `<mergeCells count="2"><mergeCell ref="A6:K6"/><mergeCell ref="A8:K8"/></mergeCells>`
    );
    expect(sheet).toMatch(/<c r="A6" t="inlineStr" s="\d+"><is><t>기타사항: 블랙 리뷰 보강<\/t><\/is><\/c>/);
    expect(sheet).toMatch(/<c r="B6" t="inlineStr" s="\d+"><is><t><\/t><\/is><\/c>/);
    expect(sheet).toMatch(/<c r="K6" t="inlineStr" s="\d+"><is><t><\/t><\/is><\/c>/);
    expect(sheet).toMatch(/<c r="K8" t="inlineStr" s="\d+"><is><t><\/t><\/is><\/c>/);
    expectCellStyleResource(styles, sheet, "K6", "fill").toContain(`rgb="FFE7F3EF"`);
    expectCellStyleResource(styles, sheet, "K6", "border").toContain(
      `<right style="thin"><color rgb="FFD8E0DE"/></right>`
    );
    expectCellStyleResource(styles, sheet, "B6", "border").toContain("<left/><right/>");
    expect(sheet).toMatch(/<c r="B3" s="\d+"><v>924000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="D4" s="\d+"><v>30<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="G4" s="\d+"><v>128000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="H4" s="\d+"><v>2\.083<\/v><\/c>/);
    expect(sheet).not.toMatch(/<c r="(?:B3|D4|G4|H4)"[^>]*t="inlineStr"/);
  });

  it("gives long merged notes a bounded explicit height so wrapped text is not clipped", () => {
    const longText = `기타사항: ${"긴 메모의 줄바꿈과 표시 높이를 검증합니다. ".repeat(30)}`;
    const input = buildCoupangDailyXlsxInput([
      total,
      group,
      increasedOption,
      noteRow({
        productName: longText,
        visualBlockKey: "group:wavebar",
        visualBlockIndex: 0
      })
    ]);
    const note = rowObject(input.rows[4]);

    expect(note.height).toBeGreaterThan(42);
    expect(note.height).toBeLessThanOrEqual(120);
    expect(note.cells).toHaveLength(11);
    expect(note.cells[0]).toEqual(
      expect.objectContaining({
        value: longText,
        fill: "GROUP_MINT",
        wrapText: true
      })
    );
    expect(note.cells.slice(1).every((cell) =>
      cell.value === "" && cell.fill === "GROUP_MINT"
    )).toBe(true);
    expect(input.merges).toEqual([
      { fromRow: 5, fromColumn: 1, toRow: 5, toColumn: 11 }
    ]);

    const sheet = readZipText(
      buildCoupangDailyXlsxWorkbook([
        total,
        group,
        increasedOption,
        noteRow({
          productName: longText,
          visualBlockKey: "group:wavebar",
          visualBlockIndex: 0
        })
      ]),
      "xl/worksheets/sheet1.xml"
    );
    expect(sheet).toContain(
      `<row r="5" ht="${note.height}" customHeight="1">`
    );
    expect(sheet).toContain(`<mergeCell ref="A5:K5"/>`);
  });

  it("keeps a summary row when the filtered report has no product rows", () => {
    const input = buildCoupangDailyXlsxInput([total]);
    expect(input.rows).toHaveLength(2);
    expect(rowCells(input.rows[1])[0]?.value).toBe("전체 합계");
    expect(input.autoFilter).toEqual({ fromRow: 1, toRow: 2 });
  });

  it("omits zero-sale products from XLSX and reindexes the remaining visual blocks", () => {
    const zeroSaleSingle = exportRow({
      productName: "광고비만 소진된 단일제품",
      reportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 0,
      adSpendKrw: 50_000,
      visualBlockKey: "product:zero-single",
      visualBlockIndex: 0
    });
    const zeroSaleSingleNote = noteRow({
      productName: "기타사항: 광고비만 소진",
      visualBlockKey: "product:zero-single",
      visualBlockIndex: 0
    });
    const visibleGroup = exportRow({
      rowKind: "그룹합계",
      productName: "판매 그룹",
      reportedSalesQuantity: 4,
      visualBlockKey: "group:visible",
      visualBlockIndex: 1,
      visualChildProductCount: 2
    });
    const soldOption = exportRow({
      rowKind: "옵션",
      productName: "판매 옵션",
      reportedSalesQuantity: 4,
      visualBlockKey: "group:visible",
      visualBlockIndex: 1,
      indentLevel: 1
    });
    const zeroSaleOption = exportRow({
      rowKind: "옵션",
      productName: "광고비만 소진된 옵션",
      reportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 0,
      adSpendKrw: 30_000,
      visualBlockKey: "group:visible",
      visualBlockIndex: 1,
      indentLevel: 1
    });
    const visibleGroupNote = noteRow({
      productName: "기타사항: 판매 그룹 메모",
      visualBlockKey: "group:visible",
      visualBlockIndex: 1
    });
    const soldSingle = exportRow({
      productName: "판매 단일제품",
      reportedSalesQuantity: 2,
      visualBlockKey: "product:sold-single",
      visualBlockIndex: 3
    });
    const emptyGroup = exportRow({
      rowKind: "그룹합계",
      productName: "판매 없는 그룹",
      reportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 0,
      visualBlockKey: "group:empty",
      visualBlockIndex: 4,
      visualChildProductCount: 1
    });
    const emptyGroupOption = exportRow({
      rowKind: "옵션",
      productName: "판매 없는 그룹 옵션",
      reportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 0,
      adSpendKrw: 20_000,
      visualBlockKey: "group:empty",
      visualBlockIndex: 4,
      indentLevel: 1
    });

    const filtered = filterCoupangDailyXlsxRows([
      total,
      zeroSaleSingle,
      zeroSaleSingleNote,
      visibleGroup,
      soldOption,
      zeroSaleOption,
      visibleGroupNote,
      soldSingle,
      emptyGroup,
      emptyGroupOption
    ]);

    expect(filtered.map((row) => row.productName)).toEqual([
      "전체 합계",
      "판매 그룹",
      "판매 옵션",
      "기타사항: 판매 그룹 메모",
      "판매 단일제품"
    ]);
    expect(filtered.map((row) => row.visualBlockIndex)).toEqual([
      null, 0, 0, 0, 1
    ]);
    expect(filtered[1]?.visualChildProductCount).toBe(1);

    const inputRows = buildCoupangDailyXlsxInput(filtered).rows;
    expect(rowCells(inputRows[2])[0]).toMatchObject({
      value: "Σ 판매 그룹 (그룹 합계 · 옵션 1개)",
      fill: "GROUP_MINT"
    });
    expect(rowCells(inputRows[5])[0]).toMatchObject({
      value: "판매 단일제품",
      fill: "GROUP_BLUE"
    });
  });

  it("keeps manual-only single products and grouped options in XLSX", () => {
    const manualOnlySingle = exportRow({
      productName: "현재 가구매 단일제품",
      reportedSalesQuantity: 0,
      previousReportedSalesQuantity: 0,
      manualPurchaseQuantity: 2,
      previousManualPurchaseQuantity: 0,
      marginKrw: null,
      visualBlockKey: "product:manual-only",
      visualBlockIndex: 3
    });
    const manualOnlyGroup = exportRow({
      rowKind: "그룹합계",
      productName: "전일 가구매 그룹",
      reportedSalesQuantity: 0,
      previousReportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 1,
      marginKrw: null,
      visualBlockKey: "group:manual-only",
      visualBlockIndex: 4,
      visualChildProductCount: 2
    });
    const manualOnlyOption = exportRow({
      rowKind: "옵션",
      productName: "전일 가구매 옵션",
      reportedSalesQuantity: 0,
      previousReportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 1,
      marginKrw: null,
      visualBlockKey: "group:manual-only",
      visualBlockIndex: 4,
      indentLevel: 1
    });
    const inactiveOption = exportRow({
      rowKind: "옵션",
      productName: "활동 없는 옵션",
      reportedSalesQuantity: 0,
      previousReportedSalesQuantity: 0,
      manualPurchaseQuantity: 0,
      previousManualPurchaseQuantity: 0,
      visualBlockKey: "group:manual-only",
      visualBlockIndex: 4,
      indentLevel: 1
    });
    const groupNote = noteRow({
      productName: "기타사항: 가구매 원본자료 확인 필요",
      visualBlockKey: "group:manual-only",
      visualBlockIndex: 4
    });

    const filtered = filterCoupangDailyXlsxRows([
      total,
      manualOnlySingle,
      manualOnlyGroup,
      manualOnlyOption,
      inactiveOption,
      groupNote
    ]);

    expect(filtered.map((row) => row.productName)).toEqual([
      "전체 합계",
      "현재 가구매 단일제품",
      "전일 가구매 그룹",
      "전일 가구매 옵션",
      "기타사항: 가구매 원본자료 확인 필요"
    ]);
    expect(filtered.map((row) => row.visualBlockIndex)).toEqual([
      null, 0, 1, 1, 1
    ]);
    expect(filtered[2]?.visualChildProductCount).toBe(1);
    expect(buildCoupangDailyXlsxInput(filtered).rows).toHaveLength(6);
  });
});

describe("daily sales quantity highlight classifier", () => {
  it.each([
    [30, 3, 15, 0, "INCREASE"],
    [26, 1, 15, 0, "NONE"],
    [25, 1, 15, 2, "INCREASE"],
    [13, 3, 13, 3, "NONE"],
    [10, 0, 20, 0, "SIGNIFICANT_DECREASE"],
    [13, 0, 20, 0, "NONE"],
    [10, 0, 18, 0, "NONE"],
    [9, 0, 18, 0, "SIGNIFICANT_DECREASE"],
    [5, 0, 10, 0, "SIGNIFICANT_DECREASE"],
    [6, 0, 10, 0, "NONE"],
    [0, 1, 0, 0, "NONE"],
    [0, 10, 0, 0, "SIGNIFICANT_DECREASE"]
  ] as const)(
    "classifies current %s-%s vs previous %s-%s as %s",
    (current, currentManual, previous, previousManual, expected) => {
      expect(classifyDailySalesQuantityHighlight(exportRow({
        reportedSalesQuantity: current,
        manualPurchaseQuantity: currentManual,
        previousReportedSalesQuantity: previous,
        previousManualPurchaseQuantity: previousManual
      }))).toBe(expected);
    }
  );

  it.each([
    { manualPurchaseQuantity: "", previousManualPurchaseQuantity: 0 },
    { manualPurchaseQuantity: null, previousManualPurchaseQuantity: 0 },
    { manualPurchaseQuantity: Number.NaN, previousManualPurchaseQuantity: 0 },
    { manualPurchaseQuantity: 0, previousManualPurchaseQuantity: "" },
    { manualPurchaseQuantity: 0, previousManualPurchaseQuantity: null },
    { manualPurchaseQuantity: 0, previousManualPurchaseQuantity: Number.POSITIVE_INFINITY }
  ] as Array<Partial<CoupangDailyExportRow>>)(
    "does not highlight missing or nonfinite manual-purchase values",
    (overrides) => {
      expect(classifyDailySalesQuantityHighlight(exportRow({
        reportedSalesQuantity: 30,
        previousReportedSalesQuantity: 10,
        ...overrides
      }))).toBe("NONE");
    }
  );

  it.each([
    ["전체합계", 94, 81],
    ["선택합계", 94, 81],
    ["기타사항", 18, 15],
    ["옵션", "", 15],
    ["옵션", null, 15],
    ["옵션", 18, ""],
    ["옵션", 18, null],
    ["옵션", Number.NaN, 15],
    ["옵션", 18, Number.POSITIVE_INFINITY]
  ] as const)("does not highlight %s with noneligible or nonfinite values", (rowKind, current, previous) => {
    expect(classifyDailySalesQuantityHighlight(exportRow({
      rowKind,
      reportedSalesQuantity: current,
      previousReportedSalesQuantity: previous
    }))).toBe("NONE");
  });
});

function exportRow(overrides: Partial<CoupangDailyExportRow> = {}): CoupangDailyExportRow {
  return {
    date: "2026-07-29",
    filterLabel: "전체 제품",
    query: "",
    reportCategories: "",
    rowKind: "단일제품",
    productName: "상품",
    reportedSalesKrw: 924_000,
    previousReportedSalesKrw: 810_000,
    reportedSalesQuantity: 13,
    previousReportedSalesQuantity: 13,
    manualPurchaseQuantity: 3,
    previousManualPurchaseQuantity: 3,
    adSpendKrw: 128_000,
    previousAdSpendKrw: 121_000,
    roas: 5.406,
    previousRoas: 5.182,
    organicSalesKrw: 246_000,
    marginKrw: 244_700,
    previousMarginKrw: 231_800,
    visualBlockKey: "product:product",
    visualBlockIndex: 0,
    indentLevel: 0,
    visualChildProductCount: null,
    ...overrides
  };
}

function noteRow(overrides: Partial<CoupangDailyExportRow> = {}) {
  return exportRow({
    rowKind: "기타사항",
    reportedSalesKrw: "",
    previousReportedSalesKrw: "",
    reportedSalesQuantity: "",
    previousReportedSalesQuantity: "",
    manualPurchaseQuantity: "",
    previousManualPurchaseQuantity: "",
    adSpendKrw: "",
    previousAdSpendKrw: "",
    roas: "",
    previousRoas: "",
    organicSalesKrw: "",
    marginKrw: "",
    previousMarginKrw: "",
    ...overrides
  });
}

function rowCells(row: XlsxCell[] | XlsxRow | undefined) {
  if (!row) throw new Error("Missing XLSX row.");
  return Array.isArray(row) ? row : row.cells;
}

function rowObject(row: XlsxCell[] | XlsxRow | undefined) {
  if (!row || Array.isArray(row)) throw new Error("Expected an XLSX row object.");
  return row;
}

function expectCellStyleResource(
  styles: string,
  sheet: string,
  cellRef: string,
  resource: "fill" | "border"
) {
  const cellMatch = sheet.match(
    new RegExp(`<c r="${cellRef}"[^>]*\\bs="(\\d+)"`)
  );
  if (!cellMatch) throw new Error(`Missing style for cell ${cellRef}.`);
  const styleId = Number(cellMatch[1]);
  const cellXfs = xmlChildren(styles, "cellXfs", "xf");
  const styleXml = cellXfs[styleId];
  if (!styleXml) {
    throw new Error(`Missing cellXf ${styleId}; parsed ${cellXfs.length}.`);
  }
  const resourceIdMatch = styleXml.match(
    new RegExp(`${resource}Id="(\\d+)"`)
  );
  if (!resourceIdMatch) {
    throw new Error(`Missing ${resource}Id on cellXf ${styleId}.`);
  }
  const resources = xmlChildren(
    styles,
    resource === "fill" ? "fills" : "borders",
    resource
  );
  const resourceXml = resources[Number(resourceIdMatch[1])];
  if (!resourceXml) {
    throw new Error(`Missing ${resource} resource ${resourceIdMatch[1]}.`);
  }
  return expect(resourceXml);
}

function xmlChildren(xml: string, sectionName: string, childName: string) {
  const section = xml.match(
    new RegExp(`<${sectionName}\\b[^>]*>([\\s\\S]*?)</${sectionName}>`)
  );
  if (!section) throw new Error(`Missing ${sectionName} section.`);
  if (childName === "xf") {
    return section[1].match(/<xf\b[^>]*>/g) ?? [];
  }
  return section[1].match(
    new RegExp(
      `<${childName}\\b[^>]*(?:/>|>[\\s\\S]*?</${childName}>)`,
      "g"
    )
  ) ?? [];
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
