import { describe, expect, it } from "vitest";
import {
  buildXlsxWorkbook,
  type XlsxCell,
  type XlsxWorkbookInput
} from "./xlsx";

describe("XLSX workbook generator", () => {
  it("keeps legacy array rows, style ids, number formats, freezing, and filtering compatible", () => {
    const rows: XlsxCell[][] = [
      [
        { value: "제품", style: "Header" },
        { value: "판매수", style: "Header" },
        { value: "매출", style: "Header" },
        { value: "비율", style: "Header" }
      ],
      [
        { value: "상품 A", style: "Text" },
        { value: 3, style: "Number" },
        { value: 15_000, style: "Krw" },
        { value: 0.125, style: "Percent" }
      ],
      [
        { value: "합계", style: "TotalText" },
        { value: 3, style: "TotalNumber" },
        { value: 15_000, style: "TotalKrw" },
        { value: 0.125, style: "TotalPercent" }
      ]
    ];

    const workbook = buildXlsxWorkbook({
      sheetName: "판매",
      columns: [{ width: 28 }, { width: 11 }, { width: 15 }, { width: 13 }],
      rows,
      freezeRow: 1,
      autoFilter: { fromRow: 1, toRow: 3 }
    });
    const styles = readZipText(workbook, "xl/styles.xml");
    const sheet = readZipText(workbook, "xl/worksheets/sheet1.xml");

    expect(styles).toContain(`numFmtId="164" formatCode="#,##0&quot;원&quot;"`);
    expect(styles).toContain(`numFmtId="166" formatCode="0.00&quot;배&quot;"`);
    expect(sheet).toContain(`<pane ySplit="1" topLeftCell="A2"`);
    expect(sheet).toContain(`<autoFilter ref="A1:D3"/>`);
    expect(sheet).toContain(`<c r="A1" t="inlineStr" s="1">`);
    expect(sheet).toContain(`<c r="A2" t="inlineStr" s="7">`);
    expect(sheet).toContain(`<c r="B2" s="2"><v>3</v></c>`);
    expect(sheet).toContain(`<c r="C2" s="3"><v>15000</v></c>`);
    expect(sheet).toContain(`<c r="A3" t="inlineStr" s="8">`);
    expect(sheet).toContain(`<c r="D3" s="12"><v>0.125</v></c>`);
    expect(sheet).not.toContain("<mergeCells");
    expect(styles).not.toContain(`wrapText="1"`);
  });

  it("supports optional merged ranges and wrapped cells without changing regular rows", () => {
    const workbook = buildXlsxWorkbook({
      sheetName: "병합",
      rows: [
        [{ value: "일반 행", style: "Text" }],
        {
          height: 48,
          cells: [{
            value: "여러 열에 걸쳐 자동 줄바꿈되는 메모",
            style: "Text",
            fill: "GROUP_MINT",
            borderTone: "GRID",
            wrapText: true
          }]
        }
      ],
      merges: [{ fromRow: 2, fromColumn: 1, toRow: 2, toColumn: 4 }]
    });
    const styles = readZipText(workbook, "xl/styles.xml");
    const sheet = readZipText(workbook, "xl/worksheets/sheet1.xml");

    expect(sheet).toContain(`<dimension ref="A1:D2"/>`);
    expect(sheet).toContain(`<row r="2" ht="48" customHeight="1">`);
    expect(sheet).toContain(
      `<mergeCells count="1"><mergeCell ref="A2:D2"/></mergeCells>`
    );
    expect(styles).toContain(`<alignment wrapText="1"/>`);
    expect(sheet).toMatch(/<c r="A2" t="inlineStr" s="\d+">/);
    expect(sheet).not.toContain(`<mergeCell ref="A1:D1"/>`);
  });

  it("rejects duplicate and intersecting merge rectangles but permits adjacent ranges", () => {
    const workbookInput = {
      sheetName: "병합 검증",
      rows: [[{ value: "값", style: "Text" as const }]]
    };

    expect(() => buildXlsxWorkbook({
      ...workbookInput,
      merges: [
        { fromRow: 1, fromColumn: 1, toRow: 1, toColumn: 3 },
        { fromRow: 1, fromColumn: 1, toRow: 1, toColumn: 3 }
      ]
    })).toThrow("XLSX merge ranges must be unique.");
    expect(() => buildXlsxWorkbook({
      ...workbookInput,
      merges: [
        { fromRow: 1, fromColumn: 1, toRow: 2, toColumn: 3 },
        { fromRow: 2, fromColumn: 2, toRow: 3, toColumn: 4 }
      ]
    })).toThrow("XLSX merge ranges must not overlap.");

    const adjacentWorkbook = buildXlsxWorkbook({
      ...workbookInput,
      merges: [
        { fromRow: 1, fromColumn: 1, toRow: 1, toColumn: 3 },
        { fromRow: 1, fromColumn: 4, toRow: 1, toColumn: 6 },
        { fromRow: 2, fromColumn: 1, toRow: 2, toColumn: 3 }
      ]
    });
    expect(readZipText(adjacentWorkbook, "xl/worksheets/sheet1.xml")).toContain(
      `<mergeCells count="3"><mergeCell ref="A1:C1"/><mergeCell ref="D1:F1"/><mergeCell ref="A2:C2"/></mergeCells>`
    );
  });

  it("allows Excel's maximum merge coordinates and rejects every coordinate above them", () => {
    const boundaryWorkbook = buildXlsxWorkbook({
      sheetName: "최대 좌표",
      rows: [],
      merges: [{
        fromRow: 1_048_576,
        fromColumn: 16_383,
        toRow: 1_048_576,
        toColumn: 16_384
      }]
    });
    const boundarySheet = readZipText(
      boundaryWorkbook,
      "xl/worksheets/sheet1.xml"
    );
    expect(boundarySheet).toContain(`<dimension ref="A1:XFD1048576"/>`);
    expect(boundarySheet).toContain(
      `<mergeCells count="1"><mergeCell ref="XFC1048576:XFD1048576"/></mergeCells>`
    );

    for (const merges of [
      [{ fromRow: 1_048_577, fromColumn: 1, toRow: 1_048_577, toColumn: 2 }],
      [{ fromRow: 1_048_576, fromColumn: 1, toRow: 1_048_577, toColumn: 2 }]
    ]) {
      expect(() => buildXlsxWorkbook({
        sheetName: "행 초과",
        rows: [],
        merges
      })).toThrow("XLSX merge rows must not exceed 1048576.");
    }
    for (const merges of [
      [{ fromRow: 1, fromColumn: 16_385, toRow: 1, toColumn: 16_385 }],
      [{ fromRow: 1, fromColumn: 16_384, toRow: 1, toColumn: 16_385 }]
    ]) {
      expect(() => buildXlsxWorkbook({
        sheetName: "열 초과",
        rows: [],
        merges
      })).toThrow("XLSX merge columns must not exceed 16384.");
    }
  });

  it("deduplicates composed styles and writes dynamic fills, fonts, borders, alignment, and row height", () => {
    const input: XlsxWorkbookInput = {
      sheetName: "스타일",
      rows: [
        [
          {
            value: "제품명",
            style: "Header",
            fill: "REPORT_HEADER",
            fontTone: "INVERSE",
            bold: true,
            borderTone: "GRID"
          },
          {
            value: "광고수익률",
            style: "Header",
            fill: "REPORT_HEADER",
            fontTone: "INVERSE",
            bold: true,
            borderTone: "GRID"
          }
        ],
        {
          height: 6,
          cells: [
            { value: "", style: "Text", borderTone: "NONE" },
            { value: "", style: "Text", borderTone: "NONE" }
          ]
        },
        [
          {
            value: "옵션 A",
            style: "Text",
            fill: "GROUP_MINT",
            fontTone: "DEFAULT",
            indent: 1,
            borderTone: "GRID"
          },
          {
            value: 5.406,
            style: "Percent1",
            fill: "GROUP_MINT",
            fontTone: "DEFAULT",
            borderTone: "GRID"
          }
        ],
        [
          {
            value: 18,
            style: "Number",
            fill: "SALES_INCREASE",
            fontTone: "INCREASE",
            bold: true,
            borderTone: "INCREASE"
          },
          {
            value: -42_000,
            style: "Krw",
            fill: "SALES_DECREASE",
            fontTone: "NEGATIVE",
            bold: true,
            borderTone: "DECREASE"
          }
        ]
      ]
    };

    const workbook = buildXlsxWorkbook(input);
    const styles = readZipText(workbook, "xl/styles.xml");
    const sheet = readZipText(workbook, "xl/worksheets/sheet1.xml");

    expect(styles).toContain(`rgb="FF385951"`);
    expect(styles).toContain(`rgb="FFE7F3EF"`);
    expect(styles).toContain(`rgb="FFDCECFF"`);
    expect(styles).toContain(`rgb="FFFFF2CC"`);
    expect(styles).toContain(`rgb="FF1557A0"`);
    expect(styles).toContain(`rgb="FFB5473B"`);
    expect(styles).toContain(`rgb="FF6C9ED8"`);
    expect(styles).toContain(`rgb="FFE2B93B"`);
    expect(styles).toContain(`formatCode="0.0%"`);
    expect(styles).toContain(`<alignment horizontal="left" indent="1"/>`);
    expect(sheet).toContain(`<row r="2" ht="6" customHeight="1">`);
    expect(sheet).toMatch(/<c r="B3" s="\d+"><v>5\.406<\/v><\/c>/);
    expect(sheet).not.toMatch(/<c r="B3"[^>]*t="inlineStr"/);
    expect(sheet).toMatch(/<c r="A4" s="\d+"><v>18<\/v><\/c>/);
    expectXmlCountsMatch(styles);
  });

  it("uses one cellXf for repeated identical visual combinations", () => {
    const repeatedCell: XlsxCell = {
      value: 1,
      style: "Number",
      fill: "GROUP_BLUE",
      fontTone: "DEFAULT",
      borderTone: "GRID"
    };
    const one = buildXlsxWorkbook({ sheetName: "한개", rows: [[repeatedCell]] });
    const many = buildXlsxWorkbook({
      sheetName: "여러개",
      rows: [[repeatedCell, { ...repeatedCell, value: 2 }, { ...repeatedCell, value: 3 }]]
    });

    expect(sectionCount(readZipText(one, "xl/styles.xml"), "cellXfs")).toBe(
      sectionCount(readZipText(many, "xl/styles.xml"), "cellXfs")
    );
  });
});

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

function expectXmlCountsMatch(styles: string) {
  for (const [section, child] of [
    ["numFmts", "numFmt"],
    ["fonts", "font"],
    ["fills", "fill"],
    ["borders", "border"],
    ["cellXfs", "xf"]
  ] as const) {
    const match = styles.match(new RegExp(`<${section} count="(\\d+)">([\\s\\S]*?)</${section}>`));
    expect(match, `${section} section`).not.toBeNull();
    const declared = Number(match?.[1]);
    const actual = match?.[2].match(new RegExp(`<${child}(?:\\s|>)`, "g"))?.length ?? 0;
    expect(declared, `${section} count`).toBe(actual);
  }
}

function sectionCount(styles: string, section: string) {
  const match = styles.match(new RegExp(`<${section} count="(\\d+)">`));
  if (!match) throw new Error(`Missing ${section} count.`);
  return Number(match[1]);
}
