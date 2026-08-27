import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { addObjectRows, addRows } from "./reports.service";

describe("ExcelJS production override compatibility", () => {
  it("preserves worksheet, cell, row, conditional-format and package-content hash on round trip", async () => {
    const first = await workbookBytes();
    const second = await workbookBytes();
    expect(await canonicalPackageHash(first)).toBe(await canonicalPackageHash(second));

    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(first as never);
    expect(loaded.worksheets.map((sheet) => sheet.name)).toEqual(["Summary", "Change Logs"]);
    expect(loaded.getWorksheet("Summary")?.rowCount).toBe(3);
    expect(loaded.getWorksheet("Summary")?.getCell("B2").value).toBe(16_000);
    expect(loaded.getWorksheet("Change Logs")?.getCell("A2").value).toBe("SCALE");
  });
});

async function workbookBytes() {
  const workbook = new ExcelJS.Workbook();
  const fixed = new Date("2026-08-26T00:00:00.000Z");
  workbook.created = fixed;
  workbook.modified = fixed;
  workbook.calcProperties.fullCalcOnLoad = false;
  const summary = workbook.addWorksheet("Summary");
  addRows(summary, [["Metric", "Value"], ["Spend KRW", 16_000], ["Margin KRW", 6_000]]);
  summary.addConditionalFormatting({
    ref: "B2:B3",
    rules: [{
      type: "cellIs",
      priority: 1,
      operator: "lessThan",
      formulae: [0],
      style: { font: { color: { argb: "FFFF0000" } } }
    }]
  });
  addObjectRows(workbook.addWorksheet("Change Logs"), [{ actionType: "SCALE", relatedDecisionId: "synthetic" }]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function canonicalPackageHash(bytes: Uint8Array) {
  const archive = await JSZip.loadAsync(bytes);
  const hash = createHash("sha256");
  for (const name of Object.keys(archive.files).sort()) {
    const entry = archive.files[name];
    if (!entry || entry.dir) continue;
    const content = await entry.async("nodebuffer");
    hash.update(`${Buffer.byteLength(name, "utf8")}:${name}:${content.length}:`, "utf8");
    hash.update(content);
  }
  return hash.digest("hex");
}
