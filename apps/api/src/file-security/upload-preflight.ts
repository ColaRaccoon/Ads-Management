import { HttpException, HttpStatus } from "@nestjs/common";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { decode } from "iconv-lite";
import JSZip from "jszip";
import { Readable } from "node:stream";
import { sanitizeUploadedFilename } from "../common/encoding";
import {
  COUPANG_BUNDLE_FIELDS,
  resolveCoupangBundleMaxTotalBytes,
  resolveProfileMaxFileBytes,
  type UploadProfile
} from "./upload-profiles";

const MIB = 1024 * 1024;

export type TextUploadInspection = {
  kind: "CSV" | "TEXT";
  rowCount: number;
  columnCount: number;
};

export type XlsxUploadInspection = {
  kind: "XLSX";
  worksheetCount: number;
  rowCount: number;
  columnCount: number;
  entryCount: number;
  expandedBytes: number;
};

export type UploadInspection = TextUploadInspection | XlsxUploadInspection;

export type CoupangBundleFiles = {
  sales?: Express.Multer.File[];
  ads?: Express.Multer.File[];
  margin?: Express.Multer.File[];
};

export type UploadStructureLimits = {
  maxTextRows: number;
  maxTextColumns: number;
  maxTextFieldCharacters: number;
  maxTextRecordCharacters: number;
  maxXlsxEntries: number;
  maxXlsxExpandedBytes: number;
  maxXlsxEntryBytes: number;
  maxXlsxCompressionRatio: number;
  maxXlsxWorksheets: number;
  maxXlsxRows: number;
  maxXlsxColumns: number;
  maxXlsxCellCharacters: number;
};

export const DEFAULT_UPLOAD_STRUCTURE_LIMITS: UploadStructureLimits = {
  maxTextRows: 100_000,
  maxTextColumns: 256,
  maxTextFieldCharacters: 32_768,
  maxTextRecordCharacters: 1024 * 1024,
  maxXlsxEntries: 2048,
  maxXlsxExpandedBytes: 96 * MIB,
  maxXlsxEntryBytes: 48 * MIB,
  maxXlsxCompressionRatio: 100,
  maxXlsxWorksheets: 32,
  maxXlsxRows: 100_000,
  maxXlsxColumns: 256,
  maxXlsxCellCharacters: 32_768
};

export function resolveUploadStructureLimits(env: NodeJS.ProcessEnv = process.env): UploadStructureLimits {
  return {
    maxTextRows: lowerOnly(env.UPLOAD_MAX_TEXT_ROWS, DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxTextRows, 1, "UPLOAD_MAX_TEXT_ROWS"),
    maxTextColumns: lowerOnly(env.UPLOAD_MAX_TEXT_COLUMNS, DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxTextColumns, 1, "UPLOAD_MAX_TEXT_COLUMNS"),
    maxTextFieldCharacters: lowerOnly(
      env.UPLOAD_MAX_TEXT_FIELD_CHARACTERS,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxTextFieldCharacters,
      64,
      "UPLOAD_MAX_TEXT_FIELD_CHARACTERS"
    ),
    maxTextRecordCharacters: lowerOnly(
      env.UPLOAD_MAX_TEXT_RECORD_CHARACTERS,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxTextRecordCharacters,
      1024,
      "UPLOAD_MAX_TEXT_RECORD_CHARACTERS"
    ),
    maxXlsxEntries: lowerOnly(env.UPLOAD_MAX_XLSX_ENTRIES, DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxEntries, 8, "UPLOAD_MAX_XLSX_ENTRIES"),
    maxXlsxExpandedBytes: lowerOnly(
      env.UPLOAD_MAX_XLSX_EXPANDED_BYTES,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxExpandedBytes,
      MIB,
      "UPLOAD_MAX_XLSX_EXPANDED_BYTES"
    ),
    maxXlsxEntryBytes: lowerOnly(
      env.UPLOAD_MAX_XLSX_ENTRY_BYTES,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxEntryBytes,
      MIB,
      "UPLOAD_MAX_XLSX_ENTRY_BYTES"
    ),
    maxXlsxCompressionRatio: lowerOnly(
      env.UPLOAD_MAX_XLSX_COMPRESSION_RATIO,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxCompressionRatio,
      2,
      "UPLOAD_MAX_XLSX_COMPRESSION_RATIO"
    ),
    maxXlsxWorksheets: lowerOnly(
      env.UPLOAD_MAX_XLSX_WORKSHEETS,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxWorksheets,
      1,
      "UPLOAD_MAX_XLSX_WORKSHEETS"
    ),
    maxXlsxRows: lowerOnly(env.UPLOAD_MAX_XLSX_ROWS, DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxRows, 1, "UPLOAD_MAX_XLSX_ROWS"),
    maxXlsxColumns: lowerOnly(
      env.UPLOAD_MAX_XLSX_COLUMNS,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxColumns,
      1,
      "UPLOAD_MAX_XLSX_COLUMNS"
    ),
    maxXlsxCellCharacters: lowerOnly(
      env.UPLOAD_MAX_XLSX_CELL_CHARACTERS,
      DEFAULT_UPLOAD_STRUCTURE_LIMITS.maxXlsxCellCharacters,
      64,
      "UPLOAD_MAX_XLSX_CELL_CHARACTERS"
    )
  };
}

export async function preflightUploadFile(
  file: Express.Multer.File,
  profile: UploadProfile,
  options: {
    env?: NodeJS.ProcessEnv;
    requireMime?: boolean;
    limits?: UploadStructureLimits;
  } = {}
): Promise<UploadInspection> {
  const env = options.env ?? process.env;
  file.originalname = sanitizeUploadedFilename(file.originalname);
  assertUploadEnvelope(file, profile, options.requireMime ?? true);
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw uploadException(HttpStatus.BAD_REQUEST, "UPLOAD_EMPTY", "The uploaded file is empty.");
  }
  const maxFileBytes = resolveProfileMaxFileBytes(profile, env);
  if (file.buffer.length > maxFileBytes) {
    throw uploadException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_TOO_LARGE", "The uploaded file is too large.");
  }
  file.size = file.buffer.length;
  const limits = options.limits ?? resolveUploadStructureLimits(env);
  if (profile.contentKind === "XLSX") {
    assertXlsxMagic(file.buffer);
    return inspectXlsxBuffer(file.buffer, limits);
  }
  assertTextMagic(file.buffer);
  return inspectTextBuffer(file.buffer, profile.contentKind, extensionOf(file.originalname), limits);
}

export async function preflightCoupangBundle(
  files: CoupangBundleFiles | undefined,
  options: { env?: NodeJS.ProcessEnv; requireMime?: boolean; limits?: UploadStructureLimits } = {}
) {
  const env = options.env ?? process.env;
  const source = files ?? {};
  const unexpectedFields = Object.keys(source).filter((field) => !(field in COUPANG_BUNDLE_FIELDS));
  if (unexpectedFields.length > 0) {
    throw uploadException(HttpStatus.BAD_REQUEST, "UPLOAD_FIELD_INVALID", "The multipart file field is not allowed.");
  }
  const pending: Array<{ field: keyof CoupangBundleFiles; file: Express.Multer.File; profile: UploadProfile }> = [];
  for (const [field, profile] of Object.entries(COUPANG_BUNDLE_FIELDS)) {
    const candidates = source[field as keyof CoupangBundleFiles] ?? [];
    if (!Array.isArray(candidates) || candidates.length > 1) {
      throw uploadException(HttpStatus.BAD_REQUEST, "UPLOAD_FILE_COUNT_INVALID", "Each bundle field accepts at most one file.");
    }
    if (candidates[0]) {
      pending.push({ field: field as keyof CoupangBundleFiles, file: candidates[0], profile });
    }
  }
  if (pending.length === 0) {
    throw uploadException(HttpStatus.BAD_REQUEST, "UPLOAD_BUNDLE_EMPTY", "At least one bundle file is required.");
  }
  const totalBytes = pending.reduce((total, item) => total + (Buffer.isBuffer(item.file.buffer) ? item.file.buffer.length : 0), 0);
  if (totalBytes > resolveCoupangBundleMaxTotalBytes(env)) {
    throw uploadException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_TOTAL_TOO_LARGE", "The multipart upload total is too large.");
  }
  const inspections: Partial<Record<keyof CoupangBundleFiles, UploadInspection>> = {};
  for (const { field, file, profile } of pending) {
    inspections[field] = await preflightUploadFile(file, profile, options);
  }
  return { totalBytes, inspections };
}

export function assertUploadEnvelope(file: Express.Multer.File, profile: UploadProfile, requireMime = true) {
  const extension = extensionOf(file.originalname);
  if (!profile.extensions.includes(extension)) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_EXTENSION_NOT_ALLOWED", "The uploaded file extension is not allowed.");
  }
  if (requireMime) {
    const mimeType = String(file.mimetype ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!profile.mimeTypes.includes(mimeType)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_MIME_NOT_ALLOWED", "The uploaded file MIME type is not allowed.");
    }
  }
}

export function inspectTextBuffer(
  buffer: Buffer,
  kind: "CSV" | "TEXT",
  extension: string,
  limits: UploadStructureLimits = DEFAULT_UPLOAD_STRUCTURE_LIMITS
): TextUploadInspection {
  assertTextMagic(buffer);
  const text = decodeText(buffer);
  if (!text.trim()) {
    throw uploadException(HttpStatus.BAD_REQUEST, "UPLOAD_EMPTY", "The uploaded file is empty.");
  }
  if (kind === "TEXT") {
    const lines = text.split(/\r\n?|\n/).filter((line) => line.length > 0);
    assertAtMost(lines.length, limits.maxTextRows, "UPLOAD_ROW_LIMIT_EXCEEDED");
    let columnCount = 1;
    for (const line of lines) {
      assertAtMost(Array.from(line).length, limits.maxTextRecordCharacters, "UPLOAD_RECORD_LIMIT_EXCEEDED");
      const columns = splitTextColumns(line, extension);
      assertAtMost(columns.length, limits.maxTextColumns, "UPLOAD_COLUMN_LIMIT_EXCEEDED");
      for (const field of columns) {
        assertAtMost(Array.from(field).length, limits.maxTextFieldCharacters, "UPLOAD_FIELD_LIMIT_EXCEEDED");
      }
      columnCount = Math.max(columnCount, columns.length);
    }
    return { kind, rowCount: lines.length, columnCount };
  }

  const delimiter = detectDelimiter(text, extension);
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: limits.maxTextRecordCharacters
    }) as string[][];
  } catch {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_TEXT_MALFORMED", "The uploaded text file is malformed.");
  }
  assertAtMost(records.length, limits.maxTextRows + 1, "UPLOAD_ROW_LIMIT_EXCEEDED");
  let columnCount = 0;
  for (const record of records) {
    assertAtMost(record.length, limits.maxTextColumns, "UPLOAD_COLUMN_LIMIT_EXCEEDED");
    for (const field of record) {
      assertAtMost(Array.from(field).length, limits.maxTextFieldCharacters, "UPLOAD_FIELD_LIMIT_EXCEEDED");
    }
    columnCount = Math.max(columnCount, record.length);
  }
  return { kind, rowCount: Math.max(0, records.length - 1), columnCount };
}

export async function inspectXlsxBuffer(
  buffer: Buffer,
  limits: UploadStructureLimits = DEFAULT_UPLOAD_STRUCTURE_LIMITS
): Promise<XlsxUploadInspection> {
  assertXlsxMagic(buffer);
  const rawCentralDirectory = inspectRawCentralDirectory(buffer, limits.maxXlsxEntries);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_INVALID", "The uploaded XLSX container is invalid.");
  }
  const entries = Object.values(zip.files);
  assertAtMost(entries.length, limits.maxXlsxEntries, "UPLOAD_XLSX_ENTRY_LIMIT_EXCEEDED");
  let declaredExpandedBytes = 0;
  const normalizedNames = new Set<string>();
  const entryMetadata = new Map<JSZip.JSZipObject, CompressedEntryMetadata>();
  for (const entry of entries) {
    assertSafeZipEntryPath(entry);
    normalizedNames.add(entry.name.replace(/\\/g, "/"));
    if (entry.dir) continue;
    const metadata = compressedMetadata(entry);
    if (!metadata) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_INVALID", "The uploaded XLSX metadata is invalid.");
    }
    entryMetadata.set(entry, metadata);
    assertAtMost(metadata.declaredUncompressedSize, limits.maxXlsxEntryBytes, "UPLOAD_XLSX_ENTRY_SIZE_EXCEEDED");
    declaredExpandedBytes += metadata.declaredUncompressedSize;
    assertAtMost(declaredExpandedBytes, limits.maxXlsxExpandedBytes, "UPLOAD_XLSX_EXPANDED_SIZE_EXCEEDED");
    const ratio = metadata.declaredUncompressedSize === 0
      ? 0
      : metadata.actualCompressedSize === 0
        ? Number.POSITIVE_INFINITY
        : metadata.declaredUncompressedSize / metadata.actualCompressedSize;
    assertAtMost(ratio, limits.maxXlsxCompressionRatio, "UPLOAD_XLSX_COMPRESSION_RATIO_EXCEEDED");
  }
  assertRequiredXlsxEntries(normalizedNames);
  assertNoMacroOrExternalEntries(normalizedNames);

  const worksheetEntries = entries.filter((entry) => !entry.dir && /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name));
  assertAtMost(worksheetEntries.length, limits.maxXlsxWorksheets, "UPLOAD_XLSX_WORKSHEET_LIMIT_EXCEEDED");
  if (worksheetEntries.length === 0) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_REQUIRED_ENTRY_MISSING", "The XLSX worksheet is missing.");
  }

  let rowCount = 0;
  let columnCount = 0;
  const actualState = { expandedBytes: 0 };
  for (const entry of entries) {
    if (entry.dir) continue;
    const metadata = entryMetadata.get(entry);
    if (!metadata) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_INVALID", "The uploaded XLSX metadata is invalid.");
    }
    const collectXml = /\.xml$/i.test(entry.name) || /\.rels$/i.test(entry.name);
    const boundedContent = await readBoundedZipEntry(entry, metadata, limits, actualState, collectXml);
    if (!collectXml) continue;
    const xml = boundedContent.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_XML_UNSAFE", "The uploaded XLSX XML is not allowed.");
    }
    if (/\.rels$/i.test(entry.name) && /\bTargetMode\s*=\s*["']External["']/i.test(xml)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_EXTERNAL_LINK_NOT_ALLOWED", "External XLSX links are not allowed.");
    }
    if (entry.name === "[Content_Types].xml" && /macroEnabled|vbaProject/i.test(xml)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_MACRO_NOT_ALLOWED", "Macro-enabled XLSX files are not allowed.");
    }
    assertXmlTextLengths(xml, limits.maxXlsxCellCharacters);
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) {
      const dimensions = inspectWorksheetXml(xml);
      rowCount = Math.max(rowCount, dimensions.rowCount);
      columnCount = Math.max(columnCount, dimensions.columnCount);
      assertAtMost(dimensions.rowCount, limits.maxXlsxRows, "UPLOAD_XLSX_ROW_LIMIT_EXCEEDED");
      assertAtMost(dimensions.columnCount, limits.maxXlsxColumns, "UPLOAD_XLSX_COLUMN_LIMIT_EXCEEDED");
    }
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buffer));
    assertAtMost(workbook.worksheets.length, limits.maxXlsxWorksheets, "UPLOAD_XLSX_WORKSHEET_LIMIT_EXCEEDED");
    for (const worksheet of workbook.worksheets) {
      assertAtMost(worksheet.actualRowCount, limits.maxXlsxRows, "UPLOAD_XLSX_ROW_LIMIT_EXCEEDED");
      assertAtMost(worksheet.actualColumnCount, limits.maxXlsxColumns, "UPLOAD_XLSX_COLUMN_LIMIT_EXCEEDED");
      worksheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => {
        assertAtMost(cellTextLength(cell.value), limits.maxXlsxCellCharacters, "UPLOAD_XLSX_CELL_LIMIT_EXCEEDED");
      }));
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_INVALID", "The uploaded XLSX workbook is invalid.");
  }

  return {
    kind: "XLSX",
    worksheetCount: worksheetEntries.length,
    rowCount,
    columnCount,
    entryCount: rawCentralDirectory.entryCount,
    expandedBytes: actualState.expandedBytes
  };
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

function inspectRawCentralDirectory(buffer: Buffer, maxEntries: number) {
  const eocdOffset = findEocdOffset(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDiskNumber = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(eocdOffset + 8);
  const declaredEntryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const zip64LocatorPresent = eocdOffset >= 20 &&
    buffer.readUInt32LE(eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE;
  if (zip64LocatorPresent || declaredEntryCount === 0xffff || diskEntryCount === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_ZIP64_NOT_ALLOWED", "ZIP64 XLSX containers are not supported.");
  }
  if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntryCount !== declaredEntryCount) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
  }
  assertAtMost(declaredEntryCount, maxEntries, "UPLOAD_XLSX_ENTRY_LIMIT_EXCEEDED");
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd !== eocdOffset || centralEnd > buffer.length) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
  }

  let cursor = centralOffset;
  let actualEntryCount = 0;
  const normalizedNames = new Set<string>();
  while (cursor < centralEnd) {
    actualEntryCount += 1;
    assertAtMost(actualEntryCount, maxEntries, "UPLOAD_XLSX_ENTRY_LIMIT_EXCEEDED");
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff || diskStart === 0xffff ||
        centralExtraContainsZip64(buffer, cursor + 46 + nameLength, extraLength)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_ZIP64_NOT_ALLOWED", "ZIP64 XLSX containers are not supported.");
    }
    if (nameLength === 0 || recordEnd > centralEnd || diskStart !== 0 || (flags & 0x0041) !== 0) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
    }
    const centralNameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const normalizedName = normalizedZipEntryName(centralNameBytes);
    if (normalizedNames.has(normalizedName)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_DUPLICATE_ENTRY", "Duplicate XLSX entries are not allowed.");
    }
    normalizedNames.add(normalizedName);
    assertMatchingLocalHeader(
      buffer,
      localHeaderOffset,
      centralOffset,
      centralNameBytes,
      flags,
      compressionMethod,
      compressedSize
    );
    cursor = recordEnd;
  }
  if (cursor !== centralEnd || actualEntryCount !== declaredEntryCount) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
  }
  return { entryCount: actualEntryCount };
}

function findEocdOffset(buffer: Buffer) {
  if (buffer.length < ZIP_EOCD_MIN_BYTES) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
  }
  const minimumOffset = Math.max(0, buffer.length - ZIP_EOCD_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = buffer.length - ZIP_EOCD_MIN_BYTES; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === buffer.length) return offset;
  }
  throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
}

function normalizedZipEntryName(nameBytes: Buffer) {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX central directory is invalid.");
  }
  const normalized = name.replace(/\\/g, "/").normalize("NFC").toLowerCase();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized) || /^(?:[a-z]:|\/)/i.test(normalized) ||
      normalized.split("/").some((part) => part === "..")) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_ENTRY_PATH_INVALID", "The XLSX entry path is invalid.");
  }
  return normalized;
}

function assertMatchingLocalHeader(
  buffer: Buffer,
  localHeaderOffset: number,
  centralOffset: number,
  centralNameBytes: Buffer,
  centralFlags: number,
  centralCompressionMethod: number,
  compressedSize: number
) {
  if (localHeaderOffset + 30 > centralOffset || buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX local header is invalid.");
  }
  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const localHeaderEnd = localHeaderOffset + 30 + localNameLength + localExtraLength;
  if (buffer.readUInt16LE(localHeaderOffset + 6) !== centralFlags ||
      buffer.readUInt16LE(localHeaderOffset + 8) !== centralCompressionMethod ||
      localNameLength !== centralNameBytes.length || localHeaderEnd > centralOffset ||
      localHeaderEnd + compressedSize > centralOffset ||
      centralExtraContainsZip64(buffer, localHeaderOffset + 30 + localNameLength, localExtraLength)) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX local header is invalid.");
  }
  const localNameBytes = buffer.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
  if (!localNameBytes.equals(centralNameBytes)) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX entry names are inconsistent.");
  }
}

function centralExtraContainsZip64(buffer: Buffer, offset: number, length: number) {
  const end = offset + length;
  if (end > buffer.length) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX extra fields are invalid.");
  }
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX extra fields are invalid.");
    }
    const fieldId = buffer.readUInt16LE(cursor);
    const fieldLength = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_CENTRAL_DIRECTORY_INVALID", "The XLSX extra fields are invalid.");
    }
    if (fieldId === 0x0001) return true;
    cursor += fieldLength;
  }
  return false;
}

function assertTextMagic(buffer: Buffer) {
  if (isZip(buffer) || buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_CONTENT_MISMATCH", "The uploaded file content does not match its type.");
  }
  for (const byte of buffer) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_CONTROL_CHARACTER_NOT_ALLOWED", "The uploaded text contains disallowed control characters.");
    }
  }
}

function assertXlsxMagic(buffer: Buffer) {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_CONTENT_MISMATCH", "The uploaded file content does not match XLSX.");
  }
}

function isZip(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08);
}

function decodeText(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    const text = decode(buffer, "cp949").replace(/^\uFEFF/, "");
    if (text.includes("\uFFFD")) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_ENCODING_NOT_ALLOWED", "The uploaded text encoding is not allowed.");
    }
    return text;
  }
}

function detectDelimiter(text: string, extension: string) {
  if (extension === ".tsv") return "\t";
  const firstLine = text.split(/\r\n?|\n/).find((line) => line.trim()) ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

function splitTextColumns(line: string, extension: string) {
  if (extension === ".tsv" || line.includes("\t")) return line.split("\t");
  if (line.includes(",")) return line.split(",");
  return [line];
}

type CompressedEntryMetadata = {
  declaredCompressedSize: number;
  declaredUncompressedSize: number;
  actualCompressedSize: number;
};

function compressedMetadata(entry: JSZip.JSZipObject): CompressedEntryMetadata | null {
  const data = (entry as JSZip.JSZipObject & {
    _data?: {
      compressedSize?: unknown;
      uncompressedSize?: unknown;
      compressedContent?: unknown;
    };
  })._data;
  const declaredCompressedSize = Number(data?.compressedSize);
  const declaredUncompressedSize = Number(data?.uncompressedSize);
  const compressedContent = data?.compressedContent;
  const actualCompressedSize = typeof compressedContent === "string"
    ? Buffer.byteLength(compressedContent, "binary")
    : compressedContent instanceof ArrayBuffer
      ? compressedContent.byteLength
      : ArrayBuffer.isView(compressedContent)
        ? compressedContent.byteLength
        : Number.NaN;
  if (!Number.isSafeInteger(declaredCompressedSize) || declaredCompressedSize < 0 ||
      !Number.isSafeInteger(declaredUncompressedSize) || declaredUncompressedSize < 0 ||
      !Number.isSafeInteger(actualCompressedSize) || actualCompressedSize < 0 ||
      actualCompressedSize !== declaredCompressedSize) {
    return null;
  }
  return { declaredCompressedSize, declaredUncompressedSize, actualCompressedSize };
}

async function readBoundedZipEntry(
  entry: JSZip.JSZipObject,
  metadata: CompressedEntryMetadata,
  limits: UploadStructureLimits,
  state: { expandedBytes: number },
  collect: boolean
) {
  const stream = entry.nodeStream("nodebuffer") as Readable;
  const chunks: Buffer[] = [];
  let actualEntryBytes = 0;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const stop = (error: HttpException) => {
      if (settled) return;
      settled = true;
      stream.pause();
      // JSZip's readable-stream adapter does not safely propagate destroy()
      // to its inflate worker. Pause both layers so no additional output is
      // materialized after a structural limit is crossed.
      (stream as Readable & { _helper?: { pause: () => void } })._helper?.pause();
      reject(error);
    };
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextEntryBytes = actualEntryBytes + buffer.length;
      const nextExpandedBytes = state.expandedBytes + buffer.length;
      if (nextEntryBytes > limits.maxXlsxEntryBytes) {
        stop(uploadException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_XLSX_ENTRY_SIZE_EXCEEDED", "The uploaded file exceeds a structural safety limit."));
        return;
      }
      if (nextExpandedBytes > limits.maxXlsxExpandedBytes) {
        stop(uploadException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_XLSX_EXPANDED_SIZE_EXCEEDED", "The uploaded file exceeds a structural safety limit."));
        return;
      }
      const actualRatio = nextEntryBytes === 0
        ? 0
        : metadata.actualCompressedSize === 0
          ? Number.POSITIVE_INFINITY
          : nextEntryBytes / metadata.actualCompressedSize;
      if (actualRatio > limits.maxXlsxCompressionRatio) {
        stop(uploadException(HttpStatus.PAYLOAD_TOO_LARGE, "UPLOAD_XLSX_COMPRESSION_RATIO_EXCEEDED", "The uploaded file exceeds a structural safety limit."));
        return;
      }
      actualEntryBytes = nextEntryBytes;
      state.expandedBytes = nextExpandedBytes;
      if (collect) chunks.push(buffer);
    });
    stream.once("error", () => {
      if (settled) return;
      if (actualEntryBytes !== metadata.declaredUncompressedSize) {
        stop(uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_SIZE_MISMATCH", "The uploaded XLSX entry size is invalid."));
        return;
      }
      stop(uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_INVALID", "The uploaded XLSX entry is invalid."));
    });
    stream.once("end", () => {
      if (settled) return;
      if (actualEntryBytes !== metadata.declaredUncompressedSize) {
        stop(uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_SIZE_MISMATCH", "The uploaded XLSX entry size is invalid."));
        return;
      }
      settled = true;
      resolve(collect ? Buffer.concat(chunks, actualEntryBytes) : Buffer.alloc(0));
    });
  });
}

function assertSafeZipEntryPath(entry: JSZip.JSZipObject) {
  const unsafeName = entry.unsafeOriginalName ?? entry.name;
  const normalized = unsafeName.replace(/\\/g, "/");
  if (/^(?:[a-z]:|\/)/i.test(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_ENTRY_PATH_INVALID", "The XLSX entry path is invalid.");
  }
}

function assertRequiredXlsxEntries(names: Set<string>) {
  const required = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"];
  if (required.some((name) => !names.has(name))) {
    throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_REQUIRED_ENTRY_MISSING", "A required XLSX entry is missing.");
  }
}

function assertNoMacroOrExternalEntries(names: Set<string>) {
  for (const name of names) {
    if (/^xl\/(?:externalLinks|queryTables)\//i.test(name) || /^xl\/connections\.xml$/i.test(name)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_EXTERNAL_LINK_NOT_ALLOWED", "External XLSX links are not allowed.");
    }
    if (/^xl\/vbaProject\.bin$/i.test(name) || /(?:^|\/)macrosheets\//i.test(name)) {
      throw uploadException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UPLOAD_XLSX_MACRO_NOT_ALLOWED", "Macro-enabled XLSX files are not allowed.");
    }
  }
}

function inspectWorksheetXml(xml: string) {
  let rowCount = (xml.match(/<row\b/gi) ?? []).length;
  let columnCount = 0;
  for (const match of xml.matchAll(/\b(?:ref|r)\s*=\s*["'](?:\$?([A-Z]{1,3})\$?(\d+))(?:\s*:\s*\$?([A-Z]{1,3})\$?(\d+))?["']/gi)) {
    columnCount = Math.max(columnCount, columnNumber(match[1]), columnNumber(match[3] ?? ""));
    rowCount = Math.max(rowCount, Number(match[2]), Number(match[4] ?? 0));
  }
  return { rowCount, columnCount };
}

function columnNumber(letters: string) {
  let value = 0;
  for (const letter of letters.toUpperCase()) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value;
}

function assertXmlTextLengths(xml: string, maxCharacters: number) {
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
    assertAtMost(Array.from(match[1]).length, maxCharacters, "UPLOAD_XLSX_CELL_LIMIT_EXCEEDED");
  }
}

function cellTextLength(value: ExcelJS.CellValue) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    return 0;
  }
  if (typeof value === "string") return Array.from(value).length;
  if ("richText" in value && Array.isArray(value.richText)) {
    return value.richText.reduce((total, part) => total + Array.from(part.text ?? "").length, 0);
  }
  if ("text" in value && typeof value.text === "string") return Array.from(value.text).length;
  if ("formula" in value && typeof value.formula === "string") return Array.from(value.formula).length;
  return 0;
}

function assertAtMost(value: number, maximum: number, code: string) {
  if (!Number.isFinite(value) || value > maximum) {
    throw uploadException(HttpStatus.PAYLOAD_TOO_LARGE, code, "The uploaded file exceeds a structural safety limit.");
  }
}

function lowerOnly(raw: string | undefined, hardDefault: number, minimum: number, name: string) {
  if (raw === undefined || raw.trim() === "") return hardDefault;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > hardDefault) {
    throw new Error(`${name} must be between ${minimum} and ${hardDefault}.`);
  }
  return parsed;
}

function uploadException(status: number, code: string, message: string) {
  return new HttpException({ code, message }, status);
}

function extensionOf(filename: string) {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
