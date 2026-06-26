import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { formatDateOnly, parseNumberValue, toDateOnly, ParseIssue } from "./date-number";

export const COUPANG_ADS_SCHEMA_VERSION = 1;

export type CoupangAdsColumnKey =
  | "metricDate"
  | "campaignName"
  | "adGroupName"
  | "adExecutionOptionId"
  | "adExecutionProductName"
  | "conversionOptionId"
  | "conversionProductName"
  | "impressions"
  | "clicks"
  | "adSpendKrw"
  | "totalOrders1d"
  | "directOrders1d"
  | "indirectOrders1d"
  | "totalConversionSales1dKrw"
  | "directConversionSales1dKrw"
  | "indirectConversionSales1dKrw"
  | "totalSalesQuantity1d"
  | "directSalesQuantity1d"
  | "indirectSalesQuantity1d";

export type ParsedCoupangAdRow = {
  metricDate: Date;
  campaignName: string | null;
  adGroupName: string | null;
  adExecutionOptionId: string | null;
  adExecutionProductName: string;
  conversionOptionId: string | null;
  conversionProductName: string;
  impressions: number;
  clicks: number;
  adSpendKrw: number;
  totalOrders1d: number;
  directOrders1d: number;
  indirectOrders1d: number;
  totalConversionSales1dKrw: number;
  directConversionSales1dKrw: number;
  indirectConversionSales1dKrw: number;
  totalSalesQuantity1d: number;
  directSalesQuantity1d: number;
  indirectSalesQuantity1d: number;
};

export type ParsedCoupangAdsRowResult = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsedRow: ParsedCoupangAdRow | null;
  issues: ParseIssue[];
};

export const COUPANG_ADS_COLUMN_ALIASES: Record<CoupangAdsColumnKey, string[]> = {
  metricDate: ["날짜", "Date", "metricDate"],
  campaignName: ["캠페인 이름", "Campaign Name", "campaignName"],
  adGroupName: ["광고그룹", "Ad Group", "adGroupName"],
  adExecutionOptionId: ["광고 집행 옵션 ID", "Ad Execution Option ID", "adExecutionOptionId"],
  adExecutionProductName: ["광고집행 상품명", "Ad Execution Product Name", "adExecutionProductName"],
  conversionOptionId: ["광고 전환 매출 발생 옵션 ID", "Conversion Option ID", "conversionOptionId"],
  conversionProductName: ["광고 전환 매출 발생 상품명", "Conversion Product Name", "conversionProductName"],
  impressions: ["노출수", "Impressions", "impressions"],
  clicks: ["클릭수", "Clicks", "clicks"],
  adSpendKrw: ["광고비(원)", "Ad Spend(KRW)", "adSpendKrw"],
  totalOrders1d: ["총 주문수(1일)", "Total Orders(1d)", "totalOrders1d"],
  directOrders1d: ["직접 주문수(1일)", "Direct Orders(1d)", "directOrders1d"],
  indirectOrders1d: ["간접 주문수(1일)", "Indirect Orders(1d)", "indirectOrders1d"],
  totalConversionSales1dKrw: ["총 전환 매출액(1일)(원)", "Total Conversion Sales(1d)(KRW)", "totalConversionSales1dKrw"],
  directConversionSales1dKrw: ["직접 전환 매출액(1일)(원)", "Direct Conversion Sales(1d)(KRW)", "directConversionSales1dKrw"],
  indirectConversionSales1dKrw: ["간접 전환 매출액(1일)(원)", "Indirect Conversion Sales(1d)(KRW)", "indirectConversionSales1dKrw"],
  totalSalesQuantity1d: ["총 판매 수량 (1일)", "Total Sales Quantity(1d)", "totalSalesQuantity1d"],
  directSalesQuantity1d: ["직접 판매 수량 (1일)", "Direct Sales Quantity(1d)", "directSalesQuantity1d"],
  indirectSalesQuantity1d: ["간접 판매 수량 (1일)", "Indirect Sales Quantity(1d)", "indirectSalesQuantity1d"]
};

export const COUPANG_ADS_REQUIRED_COLUMNS: CoupangAdsColumnKey[] = [
  "metricDate",
  "campaignName",
  "adGroupName",
  "adExecutionOptionId",
  "adExecutionProductName",
  "conversionOptionId",
  "conversionProductName",
  "impressions",
  "clicks",
  "adSpendKrw",
  "totalOrders1d",
  "directOrders1d",
  "indirectOrders1d",
  "totalConversionSales1dKrw",
  "directConversionSales1dKrw",
  "indirectConversionSales1dKrw",
  "totalSalesQuantity1d",
  "directSalesQuantity1d",
  "indirectSalesQuantity1d"
];

export class CoupangAdsXlsxParser {
  async parseBuffer(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buffer));
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { headers: [], rows: [] as ParsedCoupangAdsRowResult[], missingColumns: COUPANG_ADS_REQUIRED_COLUMNS };
    }

    const { headers, headerRowNumber } = findHeaderRow(worksheet);
    const headerMap = buildHeaderMap(headers);
    const missingColumns = COUPANG_ADS_REQUIRED_COLUMNS.filter((key) => !headerMap.has(key));
    const rows: ParsedCoupangAdsRowResult[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber || isEmptyRow(row)) {
        return;
      }
      const rawRow = rowToRawRow(row, headers);
      rows.push({
        rowNumber,
        rawRow,
        sourceRowHash: hashCoupangAdsRecord(rawRow),
        ...parseRow(rawRow, headerMap)
      });
    });

    return { headers, rows, missingColumns };
  }
}

export function coupangAdMetricKey(row: ParsedCoupangAdRow) {
  return [
    formatDateOnly(row.metricDate),
    row.campaignName ?? "",
    row.adGroupName ?? "",
    row.adExecutionOptionId ?? "",
    row.adExecutionProductName,
    row.conversionOptionId ?? "",
    row.conversionProductName
  ]
    .map((value) => value.trim())
    .join(":");
}

export function hashCoupangAdsRecord(record: unknown) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function parseRow(rawRow: Record<string, string>, headerMap: Map<CoupangAdsColumnKey, string>) {
  const issues: ParseIssue[] = [];
  const metricDate = requiredDate(rawRow, headerMap, "metricDate", issues);
  const adExecutionProductName = requiredText(rawRow, headerMap, "adExecutionProductName", issues);
  const conversionProductName = requiredText(rawRow, headerMap, "conversionProductName", issues);

  const parsedRow =
    issues.length > 0 || !metricDate
      ? null
      : {
          metricDate,
          campaignName: optionalText(rawRow, headerMap, "campaignName"),
          adGroupName: optionalText(rawRow, headerMap, "adGroupName"),
          adExecutionOptionId: optionalText(rawRow, headerMap, "adExecutionOptionId"),
          adExecutionProductName,
          conversionOptionId: optionalText(rawRow, headerMap, "conversionOptionId"),
          conversionProductName,
          impressions: Math.trunc(requiredNumber(rawRow, headerMap, "impressions", issues)),
          clicks: Math.trunc(requiredNumber(rawRow, headerMap, "clicks", issues)),
          adSpendKrw: requiredNumber(rawRow, headerMap, "adSpendKrw", issues),
          totalOrders1d: Math.trunc(requiredNumber(rawRow, headerMap, "totalOrders1d", issues)),
          directOrders1d: Math.trunc(requiredNumber(rawRow, headerMap, "directOrders1d", issues)),
          indirectOrders1d: Math.trunc(requiredNumber(rawRow, headerMap, "indirectOrders1d", issues)),
          totalConversionSales1dKrw: requiredNumber(rawRow, headerMap, "totalConversionSales1dKrw", issues),
          directConversionSales1dKrw: requiredNumber(rawRow, headerMap, "directConversionSales1dKrw", issues),
          indirectConversionSales1dKrw: requiredNumber(rawRow, headerMap, "indirectConversionSales1dKrw", issues),
          totalSalesQuantity1d: requiredNumber(rawRow, headerMap, "totalSalesQuantity1d", issues),
          directSalesQuantity1d: requiredNumber(rawRow, headerMap, "directSalesQuantity1d", issues),
          indirectSalesQuantity1d: requiredNumber(rawRow, headerMap, "indirectSalesQuantity1d", issues)
        };

  return { parsedRow: issues.length > 0 ? null : parsedRow, issues };
}

function requiredText(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangAdsColumnKey, string>,
  key: CoupangAdsColumnKey,
  issues: ParseIssue[]
) {
  const value = optionalText(rawRow, headerMap, key);
  if (!value) {
    issues.push({
      columnName: COUPANG_ADS_COLUMN_ALIASES[key][0],
      errorCode: "REQUIRED",
      message: `${COUPANG_ADS_COLUMN_ALIASES[key][0]} is required.`,
      rawValue: readRaw(rawRow, headerMap, key)
    });
  }
  return value ?? "";
}

function requiredDate(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangAdsColumnKey, string>,
  key: CoupangAdsColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = toDateOnly(rawValue);
  if (!parsed) {
    issues.push({
      columnName: COUPANG_ADS_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_DATE",
      message: `${COUPANG_ADS_COLUMN_ALIASES[key][0]} must be a valid date.`,
      rawValue
    });
  }
  return parsed;
}

function requiredNumber(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangAdsColumnKey, string>,
  key: CoupangAdsColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = parseNumberValue(rawValue, { emptyAs: 0 });
  if (parsed === null) {
    issues.push({
      columnName: COUPANG_ADS_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_NUMBER",
      message: `${COUPANG_ADS_COLUMN_ALIASES[key][0]} must be numeric.`,
      rawValue
    });
    return 0;
  }
  return parsed;
}

function optionalText(rawRow: Record<string, string>, headerMap: Map<CoupangAdsColumnKey, string>, key: CoupangAdsColumnKey) {
  const value = readRaw(rawRow, headerMap, key)?.trim();
  return value ? value : null;
}

function readRaw(rawRow: Record<string, string>, headerMap: Map<CoupangAdsColumnKey, string>, key: CoupangAdsColumnKey) {
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
  const map = new Map<CoupangAdsColumnKey, string>();
  for (const key of Object.keys(COUPANG_ADS_COLUMN_ALIASES) as CoupangAdsColumnKey[]) {
    const header = COUPANG_ADS_COLUMN_ALIASES[key]
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

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
