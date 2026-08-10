import { describe, expect, it } from "vitest";
import type { MetaCreativePerformanceRow } from "@/types/meta";
import { buildMetaAdsXlsxInput, buildMetaAdsXlsxWorkbook } from "./meta-ads-xlsx";
import type { XlsxCell, XlsxRow } from "./xlsx";

describe("Meta Ads XLSX builder", () => {
  it("exports reach and all five video rates as real percentage cells", () => {
    const input = buildMetaAdsXlsxInput([rowFixture()]);
    const headers = rowCells(input.rows[0]);
    const values = rowCells(input.rows[1]);

    expect(headers.map((cell) => cell.value).slice(-6)).toEqual([
      "도달",
      "3초 재생률",
      "25% 재생률",
      "50% 재생률",
      "75% 재생률",
      "100% 재생률"
    ]);
    expect(values[9]).toMatchObject({ value: 84, style: "Number" });
    expect(values[10]).toMatchObject({ value: 0.4880952380952381, style: "Percent" });
    expect(values[11]).toMatchObject({ value: 0.09523809523809523, style: "Percent" });
    expect(values[14]?.style).toBe("Percent");
    expect(values[14]?.value).toBeCloseTo(0.02380952380952381, 12);

    const sheet = readZipText(buildMetaAdsXlsxWorkbook([rowFixture()]), "xl/worksheets/sheet1.xml");
    expect(sheet).toContain(`<dimension ref="A1:O2"/>`);
    expect(sheet).toMatch(/<c r="K2" s="\d+"><v>0\.4880952380952381<\/v><\/c>/);
  });

  it("keeps unavailable rates as a dash while preserving real zero", () => {
    const row = rowFixture();
    row.totals.videoPlay3sRatePct = null;
    row.totals.videoPlay25RatePct = 0;
    const values = rowCells(buildMetaAdsXlsxInput([row]).rows[1]);

    expect(values[10]).toMatchObject({ value: null, style: "Percent" });
    expect(values[11]).toMatchObject({ value: 0, style: "Percent" });
  });
});

function rowFixture(): MetaCreativePerformanceRow {
  return {
    creativeKey: "creative-1",
    displayName: "여름 소재 07",
    productName: "웨이브바",
    productId: "product-1",
    materialNo: "M-07",
    deliveryStatus: "active",
    dataDays: 1,
    totals: {
      spendUsd: 10,
      spendKrw: 13_000,
      purchaseCount: 1,
      cpaUsd: 10,
      cpaKrw: 13_000,
      ctrLinkPct: 3.45,
      cpmUsd: 10,
      roas: 2,
      revenueKrw: 26_000,
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
    }
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
