import ExcelJS from "exceljs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureExplicitUploadMetadata } from "./upload-metadata-measurement";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("STEP7-EVAL-013 explicit metadata measurement safety", () => {
  it("reports aggregate metadata without file names, paths, or cell contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "step7-metadata-"));
    const forbiddenRoot = await mkdtemp(path.join(tmpdir(), "step7-forbidden-"));
    temporaryRoots.push(root);
    temporaryRoots.push(forbiddenRoot);
    const sensitiveMarker = "SYNTHETIC_PRIVATE_CELL_MARKER";
    const csvPath = path.join(root, "private-orders.csv");
    const xlsxPath = path.join(root, "private-sales.xlsx");
    await writeFile(csvPath, `name,value\n${sensitiveMarker},1`, "utf8");
    await writeFile(xlsxPath, await workbookBuffer([["name", "value"], [sensitiveMarker, 2]]));

    const result = await measureExplicitUploadMetadata([
      { profile: "META_CSV", absolutePath: csvPath },
      { profile: "COUPANG_SALES_XLSX", absolutePath: xlsxPath }
    ], { approvedRoot: root, originalBusinessRoot: forbiddenRoot });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ fileCount: 2 });
    expect(result.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "META_CSV", text: expect.objectContaining({ rows: expect.any(Object) }) }),
      expect.objectContaining({ profile: "COUPANG_SALES_XLSX", xlsx: expect.objectContaining({ worksheets: expect.any(Object) }) })
    ]));
    expect(serialized).not.toContain(sensitiveMarker);
    expect(serialized).not.toContain("private-orders.csv");
    expect(serialized).not.toContain("private-sales.xlsx");
    expect(serialized).not.toContain(root);
  });

  it("fail-closed rejects the original business worktree before file access", async () => {
    const originalRoot = await mkdtemp(path.join(tmpdir(), "step7-original-"));
    temporaryRoots.push(originalRoot);
    await expect(measureExplicitUploadMetadata(
      [{ profile: "META_CSV", absolutePath: path.join(originalRoot, "never-read.csv") }],
      { approvedRoot: originalRoot, originalBusinessRoot: originalRoot }
    )).rejects.toThrow("ORIGINAL_BUSINESS_ROOT_FORBIDDEN");
  });
});

async function workbookBuffer(rows: Array<Array<string | number>>) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Sheet1").addRows(rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
