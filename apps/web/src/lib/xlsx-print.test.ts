import assert from "node:assert/strict";
import test from "node:test";
import { buildXlsxWorkbook } from "./xlsx";

function unzipStored(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder();
  const members = new Map<string, string>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    members.set(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), decoder.decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  return members;
}

test("single-sheet callers retain numeric styles, 11pt font and formula protection without print overrides", () => {
  const zip = unzipStored(buildXlsxWorkbook({ sheetName: "기존 보고서", rows: [[{ value: "=2+2" }, { value: -1200.5, style: "Krw" }]], freezeRow: 1 }));
  const sheet = zip.get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /&apos;=2\+2/);
  assert.match(sheet, /<v>-1200\.5<\/v>/);
  assert.match(sheet, /ySplit="1" topLeftCell="A2" activePane="bottomLeft"/);
  assert.doesNotMatch(sheet, /pageSetup|pageMargins|pageSetUpPr/);
  assert.match(zip.get("xl/styles.xml")!, /<sz val="11"\/>/);
  assert.doesNotMatch(zip.get("xl/workbook.xml")!, /definedName/);
  assert.equal([...zip.keys()].filter(key => /worksheets\/sheet/.test(key)).length, 1);
});

test("multiple sheets create relationships, scoped print definitions, A4 landscape and a selected first sheet", () => {
  const zip = unzipStored(buildXlsxWorkbook({ sheets: [
    { sheetName: "보고 ' 시트", rows: [[{ value: "머리글", fontSize: 8 }], [{ value: 123 }]], freezeRow: 1, freezeColumn: 1,
      print: { orientation: "landscape", fitToWidth: 1, fitToHeight: 0, area: { fromRow: 1, toRow: 2, fromColumn: 1, toColumn: 16 }, repeatRows: { from: 1, to: 1 } } },
    { sheetName: "숫자 데이터", rows: [[{ value: .123, style: "Percent1" }]], freezeColumn: 1 }
  ] }));
  const book = zip.get("xl/workbook.xml")!, first = zip.get("xl/worksheets/sheet1.xml")!, second = zip.get("xl/worksheets/sheet2.xml")!;
  assert.match(book, /activeTab="0"/);
  assert.match(book, /name="_xlnm.Print_Area" localSheetId="0">&apos;보고 &apos;&apos; 시트&apos;!\$A\$1:\$P\$2/);
  assert.match(book, /name="_xlnm.Print_Titles" localSheetId="0">.*!\$1:\$1/);
  assert.match(first, /tabSelected="1"/);
  assert.match(first, /xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight"/);
  assert.match(first, /<sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
  assert.match(first, /paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/);
  assert.doesNotMatch(second, /tabSelected|pageSetup/);
  assert.match(second, /xSplit="1" topLeftCell="B1" activePane="topRight"/);
  assert.match(zip.get("[Content_Types].xml")!, /sheet2.xml/);
  assert.match(zip.get("xl/_rels/workbook.xml.rels")!, /Id="rId3"[^>]+Target="styles.xml"/);
  assert.match(zip.get("xl/styles.xml")!, /<sz val="8"\/>/);
});

test("invalid print ranges, page counts, font sizes and duplicate names fail instead of generating broken workbooks", () => {
  const sheet = { sheetName: "A", rows: [] };
  assert.throws(() => buildXlsxWorkbook({ sheets: [sheet, { ...sheet, sheetName: "a" }] }), /unique/);
  assert.throws(() => buildXlsxWorkbook({ ...sheet, freezeColumn: -1 }), /freeze/);
  assert.throws(() => buildXlsxWorkbook({ ...sheet, print: { orientation: "landscape", repeatRows: { from: 3, to: 1 } } }), /repeat/);
  assert.throws(() => buildXlsxWorkbook({ ...sheet, print: { orientation: "landscape", fitToHeight: -1 } }), /fit/);
  assert.throws(() => buildXlsxWorkbook({ ...sheet, rows: [[{ value: 1, fontSize: NaN }]] }), /font size/);
});
