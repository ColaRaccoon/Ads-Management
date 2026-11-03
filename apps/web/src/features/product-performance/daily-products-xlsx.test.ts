import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildDailyProductsXlsx, buildDailyProductsXlsxInput } from "./daily-products-xlsx";
import { dailyExcelFileName, filterDailyProductsForExcel, hasDailyExcelProductMembership } from "./daily-products-filter";
import { DAILY_PRODUCT_GROUPS, DAILY_PRODUCT_METRICS, type ComparedMetric, type DailyProductRow, type DailyProductsReport } from "./daily-products-model";

function metric(current: string | null = "112.3", previous: string | null = "100", changePct: string | null = "12.3"): ComparedMetric {
  return { current: { value: current, state: current === null ? "UNAVAILABLE" : "COMPLETE", isEstimate: false, reasonCodes: [] },
    previous: { value: previous, state: previous === null ? "UNAVAILABLE" : "COMPLETE", isEstimate: false, reasonCodes: [] },
    change: current === null || previous === null ? null : "12.3", changePct, comparisonReason: current === null ? "MISSING_INPUT" : null };
}
function row(productKey: string, productName: string): DailyProductRow {
  return { productKey, productName, active: true, historical: false, groups: Object.fromEntries(DAILY_PRODUCT_GROUPS.map(group =>
    [group.key, Object.fromEntries(DAILY_PRODUCT_METRICS.map(key => [key.key, metric()]))])) as DailyProductRow["groups"] };
}
function report(): DailyProductsReport {
  return { date: "2026-11-02", previousDate: "2026-11-01", snapshotHash: "published-v1", scopeLabel: "전체 계정", rows: [row("one", "제품 가나다"), row("two", "=HYPERLINK(위험)")],
    totals: row("total", "전체 합계"), warnings: ["부분 수집 자료 확인"], provisional: true,
    reconciliation: [{ key: "unallocatedAdSpend", label: "미배분 광고비", current: "0", previous: "20" }] };
}
function unzipStored(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), members = new Map<string, string>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    members.set(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), decoder.decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  return members;
}

test("Excel-only product filtering preserves source rows, every platform value, screen totals and zero-revenue products with activity", async () => {
  const source = report();
  source.rows[0].exportPlatforms = ["STOREFRONT", "GOOGLE"];
  source.rows[1].exportPlatforms = ["NAVER", "COUPANG"];
  source.rows[1].groups.NAVER.revenue = metric("0", "0", null);
  source.exportActivityVersion = 2;
  const before = structuredClone(source);
  assert.deepEqual(filterDailyProductsForExcel(source, "ALL").rows, source.rows);
  for (const platform of ["STOREFRONT", "GOOGLE", "COUPANG", "NAVER"] as const) {
    const filtered = filterDailyProductsForExcel(source, platform);
    const expected = platform === "STOREFRONT" || platform === "GOOGLE" ? source.rows[0] : source.rows[1];
    assert.deepEqual(filtered.rows, [expected]);
    assert.equal(filtered.rows[0], expected);
    assert.equal(filtered.totals, source.totals);
    assert.equal(filtered.reconciliation, source.reconciliation);
    const zip = unzipStored(buildDailyProductsXlsx(filtered));
    const numeric = zip.get("xl/worksheets/sheet2.xml")!;
    assert.match(numeric, /autoFilter ref="A1:L16"/);
    assert.doesNotMatch(numeric, /__TOTAL__|__UNASSIGNED__|미배분 광고비/);
    assert.match(zip.get("xl/worksheets/sheet1.xml")!, /엑셀 제품 필터/);
    assert.doesNotMatch(zip.get("xl/worksheets/sheet1.xml")!, /전체 합계/);
    assert.ok(dailyExcelFileName(filtered).includes(filtered.exportSelection!.label + "제품"));
    const book = new ExcelJS.Workbook();
    const bytes = buildDailyProductsXlsx(filtered), buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes); await book.xlsx.load(buffer);
    const sheet = book.getWorksheet("숫자 데이터")!;
    assert.equal(sheet.getCell("A2").value, expected.productKey);
    assert.equal(sheet.getCell("E3").value, Number(expected.groups.STOREFRONT.revenue.current.value));
  }
  assert.deepEqual(source, before);
  source.rows.forEach(row => { row.exportPlatforms = []; });
  assert.equal(filterDailyProductsForExcel(source, "GOOGLE").rows.length, 0);
  assert.equal(filterDailyProductsForExcel(source, "ALL").rows.length, 0);
});

test("missing or invalid membership never guesses platform membership from synthetic zero or positive amounts", () => {
  const source = report();
  assert.equal(hasDailyExcelProductMembership(source), false);
  assert.throws(() => filterDailyProductsForExcel(source, "STOREFRONT"), /다시 조회/);
  assert.throws(() => filterDailyProductsForExcel(source, "ALL"), /다시 조회/);
  source.rows.forEach(row => { row.exportPlatforms = ["TOTAL" as never]; });
  assert.equal(hasDailyExcelProductMembership(source), false);
});

test("all-products export also omits inactive and previous-only products without hiding their screen rows", () => {
  const source = report(); source.exportActivityVersion = 2;
  source.rows[0].exportPlatforms = ["GOOGLE"];
  source.rows[1].exportPlatforms = [];
  const before = structuredClone(source);
  const filtered = filterDailyProductsForExcel(source, "ALL");
  assert.deepEqual(filtered.rows.map(row => row.productKey), ["one"]);
  assert.equal(filtered.totals, source.totals);
  assert.equal(dailyExcelFileName(filtered), "제품통합_데일리_전체제품_2026-11-02.xlsx");
  for (const xml of unzipStored(buildDailyProductsXlsx(filtered)).values()) assert.doesNotMatch(xml, /HYPERLINK/);
  assert.deepEqual(source, before);
  source.exportActivityVersion = 1;
  assert.equal(hasDailyExcelProductMembership(source), false);
  assert.throws(() => filterDailyProductsForExcel(source, "ALL"), /다시 조회/);
});
function cell(xml: string, address: string) {
  const result = xml.match(new RegExp(`<c r="${address}"[^>]*>[\\s\\S]*?</c>`));
  assert.ok(result, address); return result[0];
}

test("report keeps 16 columns, every product, 2-line values and canonical totals with independent numeric sheet", () => {
  const data = report();
  data.totals.groups.TOTAL.revenue = metric("999999", "500000", "99.9998");
  const input = buildDailyProductsXlsxInput(data), zip = unzipStored(buildDailyProductsXlsx(data));
  assert.equal(input.sheets.length, 2);
  const sheet = zip.get("xl/worksheets/sheet1.xml")!, numeric = zip.get("xl/worksheets/sheet2.xml")!;
  assert.match(sheet, /<dimension ref="A1:P\d+"/);
  assert.match(cell(sheet, "B6"), /112[\s\S]*\n.*12\.3%/);
  assert.match(cell(sheet, "A7"), /&apos;=HYPERLINK/);
  assert.match(cell(sheet, "O8"), /999,999/);
  assert.match(cell(numeric, "E2"), /<v>112\.3<\/v>/);
  assert.match(cell(numeric, "H2"), /<v>0\.123<\/v>/);
  assert.match(cell(numeric, "B17"), /&apos;=HYPERLINK/);
  assert.match(numeric, /autoFilter ref="A1:L31"/);
  assert.match(numeric, /미배분 광고비/);
  assert.match(zip.get("xl/workbook.xml")!, /!\$4:\$5/);
  assert.match(sheet, /fitToHeight="0"/);
});

test("missing and zero values stay distinct; over-precision money and percentages remain exact text", () => {
  const data = report();
  data.rows[0].groups.STOREFRONT.adSpend = metric(null, "0", null);
  data.rows[0].groups.STOREFRONT.revenue = metric("9007199254740993.123456", "100", "12.345678901234567");
  const numeric = unzipStored(buildDailyProductsXlsx(data)).get("xl/worksheets/sheet2.xml")!;
  assert.match(cell(numeric, "E2"), /t="inlineStr"/);
  assert.doesNotMatch(cell(numeric, "E2"), /<v>0/);
  assert.match(cell(numeric, "F2"), /<v>0<\/v>/);
  assert.match(cell(numeric, "E3"), /9007199254740993\.123456/);
  assert.match(cell(numeric, "E3"), /t="inlineStr"/);
  assert.match(cell(numeric, "H3"), /12\.345678901234567%/);
  assert.match(cell(numeric, "K3"), /정밀도 보존/);
});

test("empty product lists remain printable with totals and no fabricated product rows", () => {
  const data = report(); data.rows = [];
  const zip = unzipStored(buildDailyProductsXlsx(data));
  assert.match(zip.get("xl/worksheets/sheet1.xml")!, /전체 0제품/);
  assert.match(zip.get("xl/worksheets/sheet2.xml")!, /autoFilter ref="A1:L1"/);
});

test("an independent workbook reader opens both sheets with print settings, native numeric cells and repeated headings", async () => {
  const bytes = buildDailyProductsXlsx(report());
  const book = new ExcelJS.Workbook();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await book.xlsx.load(buffer);
  assert.equal(book.worksheets.length, 2);
  const first = book.getWorksheet("전체 제품 데일리")!, numeric = book.getWorksheet("숫자 데이터")!;
  assert.equal(first.columnCount, 16);
  assert.equal(first.pageSetup.orientation, "landscape");
  assert.equal(first.pageSetup.paperSize, 9);
  assert.equal(first.pageSetup.fitToWidth, 1);
  assert.equal(first.pageSetup.fitToHeight, 0);
  assert.equal(first.pageSetup.printTitlesRow, "4:5");
  assert.match(first.pageSetup.printArea!, /^A1:P\d+$/);
  assert.equal(first.getCell("B6").font.size, 8);
  assert.equal(numeric.getCell("H2").value, .123);
  assert.equal(numeric.getCell("E2").value, 112.3);
  assert.equal(numeric.getCell("H2").numFmt, "0.0%");
});
