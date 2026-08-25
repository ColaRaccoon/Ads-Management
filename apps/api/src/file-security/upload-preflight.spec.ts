import { BadRequestException, HttpException } from "@nestjs/common";
import ExcelJS from "exceljs";
import { encode } from "iconv-lite";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { sanitizeUploadedFilename } from "../common/encoding";
import { CoupangService } from "../coupang/coupang.service";
import {
  DEFAULT_UPLOAD_STRUCTURE_LIMITS,
  inspectTextBuffer,
  inspectXlsxBuffer,
  preflightCoupangBundle,
  preflightUploadFile
} from "./upload-preflight";
import {
  bundleUploadMulterOptions,
  resolveCoupangBundleMaxTotalBytes,
  resolveProfileMaxFileBytes,
  UPLOAD_PROFILES
} from "./upload-profiles";

describe("STEP7-EVAL-001 bounded memory upload profiles", () => {
  it("sets finite per-file, file-count, part-count, and request-total limits with lower-only overrides", () => {
    const single = bundleUploadMulterOptions({ UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES: "4096" });
    expect(single.limits).toMatchObject({ fileSize: 24 * 1024 * 1024 + 1, files: 3, parts: 13 });
    expect(single.storage).toBeDefined();
    expect(resolveCoupangBundleMaxTotalBytes({ UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES: "4096" })).toBe(4096);
    expect(resolveProfileMaxFileBytes(UPLOAD_PROFILES.META_CSV, { UPLOAD_META_MAX_FILE_BYTES: "2048" })).toBe(2048);
    expect(() => resolveProfileMaxFileBytes(UPLOAD_PROFILES.META_CSV, {
      UPLOAD_META_MAX_FILE_BYTES: String(UPLOAD_PROFILES.META_CSV.maxFileBytes + 1)
    })).toThrow("UPLOAD_META_MAX_FILE_BYTES");
  });
});

describe("STEP7-EVAL-002 extension MIME magic empty and parser cross-check", () => {
  it("accepts a matching CSV envelope and rejects empty, disguised, or mismatched files", async () => {
    await expect(preflightUploadFile(csvFile("normal.csv", "text/csv", "a,b\n1,2"), UPLOAD_PROFILES.META_CSV))
      .resolves.toMatchObject({ kind: "CSV", rowCount: 1, columnCount: 2 });
    await expectUploadError(
      preflightUploadFile(csvFile("empty.csv", "text/csv", ""), UPLOAD_PROFILES.META_CSV),
      400,
      "UPLOAD_EMPTY"
    );
    await expectUploadError(
      preflightUploadFile(csvFile("fake.csv", "text/csv", Buffer.from("PK\u0003\u0004zip")), UPLOAD_PROFILES.META_CSV),
      415,
      "UPLOAD_CONTENT_MISMATCH"
    );
    await expectUploadError(
      preflightUploadFile(csvFile("fake.xlsx", "text/csv", "a,b\n1,2"), UPLOAD_PROFILES.COUPANG_SALES_XLSX),
      415,
      "UPLOAD_MIME_NOT_ALLOWED"
    );
  });

  it("maps malformed or truncated XLSX content to a stable public 415", async () => {
    await expectUploadError(
      preflightUploadFile(xlsxFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), UPLOAD_PROFILES.COUPANG_SALES_XLSX),
      415,
      "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID"
    );
  });
});

describe("STEP7-EVAL-003 XLSX ZIP and workbook preflight", () => {
  it("requires the XLSX central-directory entries", async () => {
    const zip = new JSZip();
    zip.file("note.txt", "not a workbook");
    await expectUploadError(
      inspectXlsxBuffer(await zipBuffer(zip)),
      415,
      "UPLOAD_XLSX_REQUIRED_ENTRY_MISSING"
    );
  });

  it("rejects a small high-compression synthetic ZIP bomb before workbook parsing", async () => {
    const zip = await loadValidWorkbookZip();
    zip.file("xl/media/synthetic.bin", Buffer.alloc(512 * 1024, 0x41));
    await expectUploadError(
      inspectXlsxBuffer(await zipBuffer(zip)),
      413,
      "UPLOAD_XLSX_COMPRESSION_RATIO_EXCEEDED"
    );
  });

  it("rejects forged central-directory sizes from the bounded actual inflate stream", async () => {
    const forgedBomb = await loadValidWorkbookZip();
    forgedBomb.file("xl/media/forged.bin", Buffer.alloc(4 * 1024 * 1024, 0x41));
    const forgedBombBuffer = forgeCentralUncompressedSize(await zipBuffer(forgedBomb), "xl/media/forged.bin", 1);
    await expectUploadError(
      inspectXlsxBuffer(forgedBombBuffer),
      413,
      "UPLOAD_XLSX_COMPRESSION_RATIO_EXCEEDED"
    );

    const forgedMismatch = await loadValidWorkbookZip();
    const mismatchBuffer = forgeCentralUncompressedSize(
      await zipBuffer(forgedMismatch),
      "xl/worksheets/sheet1.xml",
      1
    );
    await expectUploadError(
      inspectXlsxBuffer(mismatchBuffer, { ...DEFAULT_UPLOAD_STRUCTURE_LIMITS, maxXlsxCompressionRatio: 100 }),
      415,
      "UPLOAD_XLSX_SIZE_MISMATCH"
    );
  });

  it("rejects thousands of duplicate central records before JSZip can overwrite their map entries", async () => {
    const workbook = await workbookBuffer([["header", "value"], ["item", 1]]);
    const duplicated = duplicateCentralRecord(workbook, "xl/worksheets/sheet1.xml", 3_000);
    await expectUploadError(
      inspectXlsxBuffer(duplicated),
      413,
      "UPLOAD_XLSX_ENTRY_LIMIT_EXCEEDED"
    );

    const singleDuplicate = duplicateCentralRecord(workbook, "xl/worksheets/sheet1.xml", 1);
    await expectUploadError(
      inspectXlsxBuffer(singleDuplicate),
      415,
      "UPLOAD_XLSX_DUPLICATE_ENTRY"
    );
  });

  it("accepts a normal EOCD directory and explicitly rejects ZIP64", async () => {
    const workbook = await workbookBuffer([["header", "value"], ["item", 1]]);
    await expect(inspectXlsxBuffer(workbook)).resolves.toMatchObject({ entryCount: expect.any(Number) });

    const zip64 = Buffer.from(workbook);
    const eocdOffset = findSyntheticEocd(zip64);
    zip64.writeUInt16LE(0xffff, eocdOffset + 10);
    await expectUploadError(inspectXlsxBuffer(zip64), 415, "UPLOAD_XLSX_ZIP64_NOT_ALLOWED");
  });

  it("rejects external links, unsafe dimensions, and overlong cells", async () => {
    const external = await loadValidWorkbookZip();
    external.file("xl/externalLinks/externalLink1.xml", "<externalLink/>");
    await expectUploadError(
      inspectXlsxBuffer(await zipBuffer(external)),
      415,
      "UPLOAD_XLSX_EXTERNAL_LINK_NOT_ALLOWED"
    );

    const dimension = await loadValidWorkbookZip();
    dimension.file("xl/worksheets/sheet1.xml", minimalWorksheet("A1:ZZ100001", "ok"));
    await expectUploadError(
      inspectXlsxBuffer(await zipBuffer(dimension)),
      413,
      "UPLOAD_XLSX_ROW_LIMIT_EXCEEDED"
    );

    const longCell = await workbookBuffer([["x".repeat(65)]]);
    await expectUploadError(
      inspectXlsxBuffer(longCell, { ...DEFAULT_UPLOAD_STRUCTURE_LIMITS, maxXlsxCellCharacters: 64 }),
      413,
      "UPLOAD_XLSX_CELL_LIMIT_EXCEEDED"
    );
  });

  it("accepts a small normal workbook and reports only structural metadata", async () => {
    await expect(inspectXlsxBuffer(await workbookBuffer([["header", "value"], ["item", 3]])))
      .resolves.toMatchObject({ kind: "XLSX", worksheetCount: 1, rowCount: 2, columnCount: 2 });
  });
});

describe("STEP7-EVAL-004 CSV and text structural preflight", () => {
  it("enforces rows, columns, fields, controls, malformed quotes, and accepted Korean encoding", async () => {
    const limits = { ...DEFAULT_UPLOAD_STRUCTURE_LIMITS, maxTextRows: 1, maxTextColumns: 2, maxTextFieldCharacters: 4 };
    expect(() => inspectTextBuffer(Buffer.from("a,b\n1,2\n3,4"), "CSV", ".csv", limits))
      .toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => inspectTextBuffer(Buffer.from("a,b,c\n1,2,3"), "CSV", ".csv", limits))
      .toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => inspectTextBuffer(Buffer.from("header\nvalue"), "CSV", ".csv", limits))
      .toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => inspectTextBuffer(Buffer.from("a,b\n\"unterminated,2"), "CSV", ".csv"))
      .toThrowError(expect.objectContaining({ status: 415 }));
    expect(() => inspectTextBuffer(Buffer.from([0x61, 0x00, 0x62]), "CSV", ".csv"))
      .toThrowError(expect.objectContaining({ status: 415 }));
    expect(inspectTextBuffer(encode("항목,금액\n상품,1000", "cp949"), "CSV", ".csv"))
      .toMatchObject({ rowCount: 1, columnCount: 2 });
  });
});

describe("STEP7-EVAL-005 bundle all-or-nothing preflight", () => {
  it("rejects an empty bundle and a request-total overflow", async () => {
    await expectUploadError(preflightCoupangBundle({}), 400, "UPLOAD_BUNDLE_EMPTY");
    await expectUploadError(
      preflightCoupangBundle(
        { margin: [csvFile("margin.csv", "text/csv", "a,b\n" + "x".repeat(4096))] },
        { env: { UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES: "3072" } }
      ),
      413,
      "UPLOAD_TOTAL_TOO_LARGE"
    );
  });

  it("validates every part before invoking the first import mutation", async () => {
    const sales = vi.fn(async () => "sales");
    const ads = vi.fn(async () => "ads");
    const margin = vi.fn(async () => "margin");
    const service = Object.assign(Object.create(CoupangService.prototype) as CoupangService, {
      importSalesXlsx: sales,
      importAdsXlsx: ads,
      importMarginCsv: margin
    });
    await expect(service.importBundle({
      sales: [xlsxFile(await workbookBuffer([["a", "b"], [1, 2]]))],
      ads: [xlsxFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))]
    }, {}, "actor")).rejects.toBeInstanceOf(HttpException);
    expect(sales).not.toHaveBeenCalled();
    expect(ads).not.toHaveBeenCalled();
    expect(margin).not.toHaveBeenCalled();
  });

  it("returns a safe partial contract and a full SKIP retry resumes through per-file duplicate reuse", async () => {
    const margin = vi.fn()
      .mockResolvedValueOnce({ batchId: "margin-batch", duplicate: false })
      .mockResolvedValueOnce({ batchId: "margin-batch", duplicate: true });
    const sales = vi.fn()
      .mockRejectedValueOnce(new Error("private sales database detail"))
      .mockResolvedValueOnce({ batchId: "sales-batch", duplicate: false });
    const ads = vi.fn().mockResolvedValue({ batchId: "ads-batch", duplicate: false });
    const service = Object.assign(Object.create(CoupangService.prototype) as CoupangService, {
      importSalesXlsx: sales,
      importAdsXlsx: ads,
      importMarginCsv: margin
    });
    const files = {
      margin: [csvFile("margin.csv", "text/csv", "name,value\nitem,1")],
      sales: [xlsxFile(await workbookBuffer([["name", "value"], ["item", 1]]))],
      ads: [xlsxFile(await workbookBuffer([["name", "value"], ["item", 1]]))]
    };

    await expect(service.importBundle(files, { conflictPolicy: "SKIP" }, "actor")).rejects.toMatchObject({
      response: {
        code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
        details: { completedFields: ["margin"], failedField: "sales", retryConflictPolicy: "SKIP" }
      },
      status: 409
    });
    expect(ads).not.toHaveBeenCalled();

    await expect(service.importBundle(files, { conflictPolicy: "SKIP" }, "actor")).resolves.toEqual({
      margin: { batchId: "margin-batch", duplicate: true },
      sales: { batchId: "sales-batch", duplicate: false },
      ads: { batchId: "ads-batch", duplicate: false }
    });
    expect(margin).toHaveBeenCalledTimes(2);
    expect(sales).toHaveBeenCalledTimes(2);
    expect(ads).toHaveBeenCalledTimes(1);
    for (const call of [...margin.mock.calls, ...sales.mock.calls, ...ads.mock.calls]) {
      expect(call[1]).toMatchObject({ conflictPolicy: "SKIP" });
    }
  });

  it("preserves the first import error and never starts later bundle parts", async () => {
    const firstError = new BadRequestException({ code: "MARGIN_IMPORT_FAILED", message: "Margin import failed." });
    const margin = vi.fn().mockRejectedValue(firstError);
    const sales = vi.fn();
    const ads = vi.fn();
    const service = Object.assign(Object.create(CoupangService.prototype) as CoupangService, {
      importSalesXlsx: sales,
      importAdsXlsx: ads,
      importMarginCsv: margin
    });
    const files = {
      margin: [csvFile("margin.csv", "text/csv", "name,value\nitem,1")],
      sales: [xlsxFile(await workbookBuffer([["name", "value"], ["item", 1]]))],
      ads: [xlsxFile(await workbookBuffer([["name", "value"], ["item", 1]]))]
    };

    await expect(service.importBundle(files, { conflictPolicy: "SKIP" }, "actor")).rejects.toBe(firstError);
    expect(sales).not.toHaveBeenCalled();
    expect(ads).not.toHaveBeenCalled();
  });
});

describe("STEP7-EVAL-006 safe display filename", () => {
  it("keeps only a bounded control-free basename", () => {
    expect(sanitizeUploadedFilename("../folder/정상\u0000파일.csv")).toBe("정상_파일.csv");
    expect(sanitizeUploadedFilename("C:\\private\\orders.csv")).toBe("orders.csv");
    expect(Array.from(sanitizeUploadedFilename(`${"가".repeat(300)}.csv`))).toHaveLength(180);
  });
});

describe("STEP7-EVAL-013 synthetic normal profile regression", () => {
  it("accepts normal Meta/Cafe24/Coupang text and XLSX contracts without persisting source files", async () => {
    for (const profile of [UPLOAD_PROFILES.META_CSV, UPLOAD_PROFILES.CAFE24_CSV, UPLOAD_PROFILES.COUPANG_MARGIN_TEXT]) {
      await expect(preflightUploadFile(csvFile("normal.csv", "text/csv", "name,value\nitem,1"), profile))
        .resolves.toMatchObject({ rowCount: 1, columnCount: 2 });
    }
    await expect(preflightUploadFile(csvFile("prices.txt", "text/plain", "item = 1000"), UPLOAD_PROFILES.COUPANG_PRICE_TEXT))
      .resolves.toMatchObject({ rowCount: 1 });
    const workbook = await workbookBuffer([["name", "value"], ["item", 1]]);
    for (const profile of [
      UPLOAD_PROFILES.COUPANG_SALES_XLSX,
      UPLOAD_PROFILES.COUPANG_ADS_XLSX,
      UPLOAD_PROFILES.COUPANG_PROMOTION_XLSX
    ]) {
      await expect(preflightUploadFile(xlsxFile(workbook), profile)).resolves.toMatchObject({ worksheetCount: 1 });
    }
  });
});

function csvFile(originalname: string, mimetype: string, content: string | Buffer): Express.Multer.File {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return { originalname, mimetype, buffer, size: buffer.length, fieldname: "file" } as Express.Multer.File;
}

function xlsxFile(buffer: Buffer): Express.Multer.File {
  return {
    originalname: "normal.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    size: buffer.length,
    fieldname: "file"
  } as Express.Multer.File;
}

async function workbookBuffer(rows: Array<Array<string | number>>) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Sheet1").addRows(rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function loadValidWorkbookZip() {
  return JSZip.loadAsync(await workbookBuffer([["a", "b"], [1, 2]]));
}

async function zipBuffer(zip: JSZip) {
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

function minimalWorksheet(dimension: string, value: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData>
</worksheet>`;
}

function forgeCentralUncompressedSize(buffer: Buffer, entryName: string, size: number) {
  const forged = Buffer.from(buffer);
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while (offset < forged.length) {
    const centralOffset = forged.indexOf(centralSignature, offset);
    if (centralOffset < 0) break;
    const nameLength = forged.readUInt16LE(centralOffset + 28);
    const extraLength = forged.readUInt16LE(centralOffset + 30);
    const commentLength = forged.readUInt16LE(centralOffset + 32);
    const nameStart = centralOffset + 46;
    const name = forged.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === entryName) {
      forged.writeUInt32LE(size, centralOffset + 24);
      return forged;
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  throw new Error("Synthetic ZIP entry was not found.");
}

function duplicateCentralRecord(buffer: Buffer, entryName: string, copies: number) {
  const eocdOffset = findSyntheticEocd(buffer);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralEnd = centralOffset + centralSize;
  let cursor = centralOffset;
  let target: Buffer | null = null;
  while (cursor < centralEnd) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === entryName) target = buffer.subarray(cursor, recordEnd);
    cursor = recordEnd;
  }
  if (!target) throw new Error("Synthetic ZIP entry was not found.");
  const extraCentralRecords = Buffer.concat(Array.from({ length: copies }, () => target));
  const duplicated = Buffer.concat([
    buffer.subarray(0, eocdOffset),
    extraCentralRecords,
    buffer.subarray(eocdOffset)
  ]);
  const newEocdOffset = eocdOffset + extraCentralRecords.length;
  const entryCount = buffer.readUInt16LE(eocdOffset + 10) + copies;
  duplicated.writeUInt16LE(entryCount, newEocdOffset + 8);
  duplicated.writeUInt16LE(entryCount, newEocdOffset + 10);
  duplicated.writeUInt32LE(centralSize + extraCentralRecords.length, newEocdOffset + 12);
  return duplicated;
}

function findSyntheticEocd(buffer: Buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = buffer.lastIndexOf(signature);
  if (offset < 0) throw new Error("Synthetic ZIP EOCD was not found.");
  return offset;
}

async function expectUploadError(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected upload error ${code}.`);
}
