import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { formatDateOnly, parseDateString, parseNumberValue, toDateOnly, ParseIssue } from "./date-number";

export const COUPANG_SALES_SCHEMA_VERSION = 1;

export type CoupangCancelAmountMode = "SALES_IS_NET" | "NEGATIVE_ADD" | "POSITIVE_SUBTRACT";

export type CoupangSalesColumnKey =
  | "optionId"
  | "optionName"
  | "productName"
  | "registeredProductId"
  | "category"
  | "saleMethod"
  | "salesKrw"
  | "orderCount"
  | "salesQuantity"
  | "totalSalesKrw"
  | "totalSalesQuantity"
  | "cancelAmountKrw"
  | "cancelQuantity"
  | "instantCancelQuantity";

export type ParsedCoupangSaleRow = {
  optionId: string | null;
  optionName: string;
  productName: string;
  registeredProductId: string | null;
  category: string | null;
  saleMethod: string | null;
  salesKrw: number;
  orderCount: number;
  salesQuantity: number;
  totalSalesKrw: number;
  totalSalesQuantity: number;
  cancelAmountKrw: number;
  cancelQuantity: number;
  instantCancelQuantity: number;
  netSalesKrw: number;
  saleDate: Date | null;
};

export const COUPANG_SALES_COLUMN_ALIASES: Record<CoupangSalesColumnKey, string[]> = {
  optionId: ["옵션 ID", "Option ID", "optionId"],
  optionName: ["옵션명", "Option Name", "optionName"],
  productName: ["상품명", "Product Name", "productName"],
  registeredProductId: ["등록상품 ID", "등록상품ID", "Registered Product ID", "registeredProductId"],
  category: ["카테고리", "Category", "category"],
  saleMethod: ["판매방식", "Sale Method", "saleMethod"],
  salesKrw: ["매출(원)", "Sales(KRW)", "salesKrw"],
  orderCount: ["주문", "Orders", "orderCount"],
  salesQuantity: ["판매량", "판매수량", "Sales Quantity", "salesQuantity"],
  totalSalesKrw: ["총 매출(원)", "Total Sales(KRW)", "totalSalesKrw"],
  totalSalesQuantity: ["총 판매수", "총 판매수량", "Total Sales Quantity", "totalSalesQuantity"],
  cancelAmountKrw: ["총 취소 금액(원)", "Cancel Amount(KRW)", "cancelAmountKrw"],
  cancelQuantity: ["총 취소된 상품수", "총 취소된 상품수량", "Cancel Quantity", "cancelQuantity"],
  instantCancelQuantity: ["즉시 취소된 상품수", "즉시 취소된 상품수량", "Instant Cancel Quantity", "instantCancelQuantity"]
};

export const COUPANG_SALES_REQUIRED_COLUMNS: CoupangSalesColumnKey[] = [
  "optionId",
  "optionName",
  "productName",
  "saleMethod",
  "salesKrw",
  "orderCount",
  "salesQuantity",
  "totalSalesKrw",
  "totalSalesQuantity",
  "cancelAmountKrw",
  "cancelQuantity",
  "instantCancelQuantity"
];

export class CoupangSalesXlsxParser {
  async parseBuffer(
    buffer: Buffer,
    options: { reportDate?: string | null; cancelAmountMode?: CoupangCancelAmountMode; filename?: string } = {}
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buffer));
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { headers: [], rows: [] as ParsedCoupangSalesRowResult[], missingColumns: COUPANG_SALES_REQUIRED_COLUMNS };
    }

    const { headers, headerRowNumber } = findHeaderRow(worksheet);
    const headerMap = buildHeaderMap(headers);
    const missingColumns = COUPANG_SALES_REQUIRED_COLUMNS.filter((key) => !headerMap.has(key));
    const fallbackDate = toDateOnly(options.reportDate ?? extractDateFromFilename(options.filename ?? "") ?? undefined);
    const rows: ParsedCoupangSalesRowResult[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber || isEmptyRow(row)) {
        return;
      }
      const rawRow = rowToRawRow(row, headers);
      rows.push({
        rowNumber,
        rawRow,
        sourceRowHash: hashCoupangSalesRecord(rawRow),
        ...parseRow(rawRow, headerMap, {
          fallbackDate,
          cancelAmountMode: options.cancelAmountMode ?? "SALES_IS_NET"
        })
      });
    });

    return { headers, rows, missingColumns };
  }
}

export type ParsedCoupangSalesRowResult = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsedRow: ParsedCoupangSaleRow | null;
  issues: ParseIssue[];
};

export function coupangSaleLineKey(row: ParsedCoupangSaleRow) {
  return [formatDateOrEmpty(row.saleDate), row.optionId ?? "", row.productName, row.optionName].map((value) => value.trim()).join(":");
}

export function hashCoupangSalesRecord(record: unknown) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export function extractDateFromFilename(filename: string) {
  const compact = filename.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  const shortCompact = filename.match(/(?:^|[^\d])(\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
  if (shortCompact) {
    return parseDateString(`20${shortCompact[1]}-${shortCompact[2]}-${shortCompact[3]}`);
  }
  const separated = filename.match(/(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (separated) {
    return parseDateString(`${separated[1]}-${separated[2]}-${separated[3]}`);
  }
  return null;
}

function parseRow(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangSalesColumnKey, string>,
  options: { fallbackDate: Date | null; cancelAmountMode: CoupangCancelAmountMode }
) {
  const issues: ParseIssue[] = [];
  const optionId = optionalText(rawRow, headerMap, "optionId");
  const optionName = requiredText(rawRow, headerMap, "optionName", issues);
  const productName = requiredText(rawRow, headerMap, "productName", issues);
  const salesKrw = requiredNumber(rawRow, headerMap, "salesKrw", issues);
  const orderCount = Math.trunc(requiredNumber(rawRow, headerMap, "orderCount", issues));
  const salesQuantity = requiredNumber(rawRow, headerMap, "salesQuantity", issues);
  const totalSalesKrw = requiredNumber(rawRow, headerMap, "totalSalesKrw", issues);
  const totalSalesQuantity = requiredNumber(rawRow, headerMap, "totalSalesQuantity", issues);
  const cancelAmountKrw = requiredNumber(rawRow, headerMap, "cancelAmountKrw", issues);
  const cancelQuantity = requiredNumber(rawRow, headerMap, "cancelQuantity", issues);
  const instantCancelQuantity = requiredNumber(rawRow, headerMap, "instantCancelQuantity", issues);

  if (issues.length > 0) {
    return { parsedRow: null, issues };
  }

  const netSalesKrw = calculateCoupangNetSales({
    salesKrw,
    cancelAmountKrw,
    mode: options.cancelAmountMode
  });

  return {
    parsedRow: {
      optionId,
      optionName,
      productName,
      registeredProductId: optionalText(rawRow, headerMap, "registeredProductId"),
      category: optionalText(rawRow, headerMap, "category"),
      saleMethod: optionalText(rawRow, headerMap, "saleMethod"),
      salesKrw,
      orderCount,
      salesQuantity,
      totalSalesKrw,
      totalSalesQuantity,
      cancelAmountKrw,
      cancelQuantity,
      instantCancelQuantity,
      netSalesKrw,
      saleDate: options.fallbackDate
    },
    issues
  };
}

function calculateCoupangNetSales(input: { salesKrw: number; cancelAmountKrw: number; mode: CoupangCancelAmountMode }) {
  if (input.mode === "NEGATIVE_ADD") {
    return input.salesKrw + input.cancelAmountKrw;
  }
  if (input.mode === "POSITIVE_SUBTRACT") {
    return input.salesKrw - Math.abs(input.cancelAmountKrw);
  }
  return input.salesKrw;
}

function requiredText(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangSalesColumnKey, string>,
  key: CoupangSalesColumnKey,
  issues: ParseIssue[]
) {
  const value = optionalText(rawRow, headerMap, key);
  if (!value) {
    issues.push({
      columnName: COUPANG_SALES_COLUMN_ALIASES[key][0],
      errorCode: "REQUIRED",
      message: `${COUPANG_SALES_COLUMN_ALIASES[key][0]} is required.`,
      rawValue: readRaw(rawRow, headerMap, key)
    });
  }
  return value ?? "";
}

function requiredNumber(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangSalesColumnKey, string>,
  key: CoupangSalesColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = parseNumberValue(rawValue, { emptyAs: 0 });
  if (parsed === null) {
    issues.push({
      columnName: COUPANG_SALES_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_NUMBER",
      message: `${COUPANG_SALES_COLUMN_ALIASES[key][0]} must be numeric.`,
      rawValue
    });
    return 0;
  }
  return parsed;
}

function optionalText(rawRow: Record<string, string>, headerMap: Map<CoupangSalesColumnKey, string>, key: CoupangSalesColumnKey) {
  const value = readRaw(rawRow, headerMap, key)?.trim();
  return value ? value : null;
}

function readRaw(rawRow: Record<string, string>, headerMap: Map<CoupangSalesColumnKey, string>, key: CoupangSalesColumnKey) {
  const header = headerMap.get(key);
  return header ? rawRow[header] : undefined;
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  let headers: string[] = [];
  let headerRowNumber = 1;
  worksheet.eachRow((row, rowNumber) => {
    if (headers.length > 0) {
      return;
    }
    const values = rowToValues(row);
    if (values.filter(Boolean).length >= 3) {
      headers = values;
      headerRowNumber = rowNumber;
    }
  });
  return { headers, headerRowNumber };
}

function buildHeaderMap(headers: string[]) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const map = new Map<CoupangSalesColumnKey, string>();
  for (const key of Object.keys(COUPANG_SALES_COLUMN_ALIASES) as CoupangSalesColumnKey[]) {
    const header = COUPANG_SALES_COLUMN_ALIASES[key]
      .map(normalizeHeader)
      .map((alias) => normalizedHeaders.get(alias))
      .find((value): value is string => Boolean(value));
    if (header) {
      map.set(key, header);
    }
  }
  return map;
}

function rowToRawRow(row: ExcelJS.Row, headers: string[]) {
  const rawRow: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (header) {
      rawRow[header] = cellToText(row.getCell(index + 1));
    }
  });
  return rawRow;
}

function rowToValues(row: ExcelJS.Row) {
  const values: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    values[columnNumber - 1] = cellToText(cell).trim();
  });
  return values;
}

function isEmptyRow(row: ExcelJS.Row) {
  return rowToValues(row).every((value) => !value);
}

function cellToText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return formatDateOnly(value);
  }
  if (typeof value === "object") {
    if ("text" in value && value.text !== undefined) {
      return String(value.text);
    }
    if ("result" in value && value.result !== undefined) {
      return String(value.result);
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return String(value);
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim().toLowerCase();
}

function formatDateOrEmpty(date: Date | null) {
  return date ? formatDateOnly(date) : "";
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
