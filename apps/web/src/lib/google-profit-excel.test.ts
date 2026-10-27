import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleProfitRow, GoogleReportResponse } from "../types/google";
import { buildGoogleProfitExcel, googleProfitExcelFileName, loadGoogleProfitExport } from "./google-profit-excel";

function product(id: string, overrides: Partial<GoogleProfitRow> = {}): GoogleProfitRow {
  return {
    productId: id, date: "2026-10-26", quantity: 2, lineCount: 2,
    revenueKrw: 10000, knownRevenueKrw: 10000, collectedRevenueKrw: 10000,
    grossCostKrw: 6000, couponDeductionKrw: 1000,
    adSpendKrw: 4000.125, adSpendKrwExact: "4000.125", knownAdSpendKrw: 4000.125,
    marginKrw: -1000.125, calculatedMarginKrw: -1000.125, marginRate: -0.1000125, roas: 2.49992187744133,
    impressions: 1000, clicks: 17, ctr: 0.017, cpcKrw: 235.3014705882353, costPerSaleKrw: 2000.0625,
    priceMismatchCount: 0, complete: true, warningCodes: [], ...overrides
  };
}

function report(rows: GoogleProfitRow[], page = 1, total = rows.length): GoogleReportResponse {
  return {
    range: { from: "2026-10-26", to: "2026-10-26" }, products: rows, daily: [], campaigns: [], unmappedSales: [],
    summary: { ...product("summary", { marginKrw: -9999.5, quantity: 123 }), calculatedProductsMarginKrw: -9999.5, allocatedAdSpendKrw: 4000.125, unallocatedAdSpendKrw: 0, unmappedSalesCount: 0 },
    pagination: { page, pageSize: 50, total },
    completeness: { complete: true, missingGoogleDates: [], missingCafe24Dates: [], completeDates: ["2026-10-26"], warningCodes: [] },
    reconciliation: { balanced: true, byCurrency: [], collectedAdSpendKrwExact: "4000.125", allocatedAdSpendKrwExact: "4000.125", unallocatedAdSpendKrwExact: "0" },
    coverage: [], notices: []
  };
}

/** Inspect ZIP members rather than searching bytes across the whole archive. */
function unzipStored(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const members = new Map<string, string>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    members.set(name, decoder.decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  return members;
}

function cell(xml: string, ref: string) {
  const match = xml.match(new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?</c>`));
  assert.ok(match, `Missing cell ${ref}`);
  return match[0];
}

test("Google Excel keeps Meta column order, numeric precision, total style and filter bounds", () => {
  const bytes = buildGoogleProfitExcel(report([product("one")]), () => "두줄 무릎보호대", { generatedAt: new Date("2026-10-26T15:00:00Z"), filterLabel: "상품: 두줄 무릎보호대" });
  const zip = unzipStored(bytes);
  const sheet = zip.get("xl/worksheets/sheet1.xml")!;
  const styles = zip.get("xl/styles.xml")!;
  assert.match(zip.get("xl/workbook.xml")!, /name="Google 마진"/);
  assert.match(cell(sheet, "B1"), /2026-10-26/);
  assert.match(cell(sheet, "D1"), /2026\. 10\. 27\./);
  assert.match(cell(sheet, "B2"), /상품: 두줄 무릎보호대/);
  assert.match(cell(sheet, "G4"), /쿠폰 적용 전 마진/);
  assert.match(cell(sheet, "H4"), /최종 순마진/);
  assert.match(cell(sheet, "J4"), /판매 1개당 광고비/);
  assert.doesNotMatch(sheet, /전환당 비용|규칙 일치 주문|추정 주문/);
  assert.match(cell(sheet, "E5"), /<v>4000\.125<\/v>/);
  assert.match(cell(sheet, "F5"), /<v>11000\.125<\/v>/);
  assert.match(cell(sheet, "G5"), /<v>-0\.125<\/v>/);
  assert.match(cell(sheet, "H5"), /<v>-1000\.125<\/v>/);
  assert.match(cell(sheet, "I5"), /<v>2\.49992187744133<\/v>/);
  assert.match(cell(sheet, "N5"), /<v>0\.017<\/v>/);
  assert.match(cell(sheet, "A6"), /合計|합계/);
  assert.match(cell(sheet, "H6"), /<v>-9999\.5<\/v>/); // Server total, not product subtotal.
  assert.match(cell(sheet, "B6"), /<v>123<\/v>/);
  const xfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)!;
  for (const ref of ["I5", "K5", "N5", "I6", "K6", "N6"]) {
    const styleId = Number(cell(sheet, ref).match(/ s="(\d+)"/)![1]);
    assert.match(xfs[styleId], /numFmtId="9"/); // Integer percentage; values remain precise.
  }
  assert.notEqual(cell(sheet, "H5").match(/ s="(\d+)"/)![1], cell(sheet, "H6").match(/ s="(\d+)"/)![1]);
  assert.match(sheet, /ySplit="4" topLeftCell="A5"/);
  assert.match(sheet, /autoFilter ref="A4:P5"/); // Total row excluded.
  assert.match(sheet, /<row r="1" ht="48" customHeight="1">/);
  assert.match(sheet, /<row r="2" ht="36" customHeight="1">/);
  assert.match(sheet, /<mergeCell ref="B2:H2"\/>/);
  for (const ref of ["B1", "D1", "B2"]) {
    const styleId = Number(cell(sheet, ref).match(/ s="(\d+)"/)![1]);
    assert.match(xfs[styleId], /wrapText="1"/);
  }
});

test("unconfirmed numeric values remain blank and separate from measured zero", () => {
  const row = product("unknown", { complete: false, revenueKrw: null, grossCostKrw: null, couponDeductionKrw: null, adSpendKrw: null, marginKrw: null, marginRate: null, roas: null, costPerSaleKrw: null, cpcKrw: null, quantity: 0, clicks: 0, ctr: 0 });
  const sheet = unzipStored(buildGoogleProfitExcel(report([row]), () => "=HYPERLINK(\"unsafe\")")).get("xl/worksheets/sheet1.xml")!;
  for (const ref of ["C5", "D5", "E5", "F5", "G5", "H5", "I5", "J5", "K5", "O5"]) {
    assert.match(cell(sheet, ref), /<t><\/t>/);
    assert.doesNotMatch(cell(sheet, ref), /<v>/);
  }
  assert.match(cell(sheet, "B5"), /<v>0<\/v>/);
  assert.match(cell(sheet, "N5"), /<v>0<\/v>/);
  assert.match(cell(sheet, "P5"), /미확정/);
  assert.match(cell(sheet, "A5"), /&apos;=HYPERLINK/);
  assert.doesNotMatch(sheet, /<f>/);
});

test("export loads 51 products across pages and preserves all selected filters", async () => {
  const all = Array.from({ length: 51 }, (_, index) => product(String(index)));
  const queries: URLSearchParams[] = [];
  const data = await loadGoogleProfitExport("from=2026-10-26&to=2026-10-26&productId=selected&connectionId=google&cafe24ConnectionId=store&page=7&pageSize=1", async (query) => {
    const params = new URLSearchParams(query);
    queries.push(params);
    const page = Number(params.get("page"));
    return report(all.slice((page - 1) * 50, page * 50), page, 51);
  });
  assert.equal(data.products.length, 51);
  assert.equal(data.summary.marginKrw, -9999.5);
  assert.equal(queries.length, 2);
  queries.forEach((params, index) => {
    assert.equal(params.get("page"), String(index + 1));
    assert.equal(params.get("pageSize"), "50");
    assert.equal(params.get("productId"), "selected");
    assert.equal(params.get("connectionId"), "google");
    assert.equal(params.get("cafe24ConnectionId"), "store");
  });
  const sheet = unzipStored(buildGoogleProfitExcel(data, (id) => id!)).get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /autoFilter ref="A4:P55"/);
  assert.match(cell(sheet, "A55"), /<t>50<\/t>/);
  assert.match(cell(sheet, "A56"), /합계/);
});

test("partial page, duplicate product, changed totals or snapshots abort export", async () => {
  const first = Array.from({ length: 50 }, (_, index) => product(String(index)));
  const cases: Array<(data: GoogleReportResponse) => void> = [
    (data) => { data.products = []; },
    (data) => { data.products[0].productId = "0"; },
    (data) => { data.pagination.total = 52; },
    (data) => { data.pagination.page = 1; },
    (data) => { data.pagination.pageSize = 100; },
    (data) => { data.summary.marginKrw = 1; },
    (data) => { data.range.to = "2026-10-25"; },
    (data) => { data.completeness.complete = false; },
    (data) => { data.reconciliation.balanced = false; }
  ];
  for (const mutate of cases) {
    await assert.rejects(loadGoogleProfitExport("from=2026-10-26&to=2026-10-26", async (query) => {
      if (new URLSearchParams(query).get("page") === "1") return report(first, 1, 51);
      const second = report([product("50")], 2, 51);
      mutate(second);
      return second;
    }), /다시 다운로드/);
  }
  await assert.rejects(loadGoogleProfitExport("", async (query) => {
    if (new URLSearchParams(query).get("page") === "1") return report(first, 1, 51);
    throw new Error("network error");
  }), /network error/);
  assert.throws(() => buildGoogleProfitExcel(report(first, 1, 51), (id) => id!), /다시 다운로드/);
});

test("empty report remains valid and filenames follow the selected date range", async () => {
  const data = await loadGoogleProfitExport("", async () => report([]));
  const sheet = unzipStored(buildGoogleProfitExcel(data, () => "")).get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /autoFilter ref="A4:P4"/);
  assert.match(cell(sheet, "A5"), /합계/);
  assert.equal(googleProfitExcelFileName(data.range), "2026-10-26_Google_마진.xlsx");
  assert.equal(googleProfitExcelFileName({ from: "2026-10-20", to: "2026-10-26" }), "2026-10-20~2026-10-26_Google_마진.xlsx");
});
