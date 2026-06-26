import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { formatDateOnly, parseDateString, parseNumberValue, toDateOnly, ParseIssue } from "./date-number";

export const COUPANG_PROMOTION_SCHEMA_VERSION = 1;

export type CoupangPromotionColumnKey =
  | "sourcePromotionId"
  | "productText"
  | "rawProductName"
  | "rawOptionName"
  | "optionId"
  | "originalSalePriceKrw"
  | "promotionPriceKrw"
  | "promotionQuantity"
  | "shippingType"
  | "promotionStatus"
  | "promotionStartDate"
  | "promotionEndDate"
  | "exposureArea"
  | "salesAmountKrw"
  | "impressions"
  | "orderQuantity"
  | "saleMethod"
  | "requestedAt";

export type ParsedCoupangPromotionRow = {
  sourcePromotionId: string | null;
  productText: string;
  rawProductName: string | null;
  rawOptionName: string | null;
  optionId: string | null;
  originalSalePriceKrw: number;
  promotionPriceKrw: number;
  promotionQuantity: number;
  shippingType: string | null;
  promotionStatus: string | null;
  promotionStartDate: Date;
  promotionEndDate: Date;
  rawStartAt: string | null;
  rawEndAt: string | null;
  exposureArea: string | null;
  salesAmountKrw: number;
  impressions: number;
  orderQuantity: number;
  saleMethod: string | null;
  requestedAt: Date | null;
};

export type ParsedCoupangPromotionRowResult = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsedRow: ParsedCoupangPromotionRow | null;
  issues: ParseIssue[];
};

export const COUPANG_PROMOTION_COLUMN_ALIASES: Record<CoupangPromotionColumnKey, string[]> = {
  sourcePromotionId: ["ID", "Promotion ID", "sourcePromotionId"],
  productText: ["등록상품명, 옵션명", "등록상품명,옵션명", "Product/Option Name", "productText"],
  rawProductName: ["등록상품명", "Product Name", "registeredProductName", "rawProductName"],
  rawOptionName: ["옵션명", "Option Name", "optionName", "rawOptionName"],
  optionId: ["옵션ID", "옵션 ID", "Option ID", "optionId"],
  originalSalePriceKrw: ["판매가", "Sale Price", "originalSalePriceKrw"],
  promotionPriceKrw: ["프로모션 가격", "Promotion Price", "promotionPriceKrw"],
  promotionQuantity: ["프로모션 수량", "Promotion Quantity", "promotionQuantity"],
  shippingType: ["현재 배송비종류", "Shipping Type", "shippingType"],
  promotionStatus: ["프로모션 상태", "Promotion Status", "promotionStatus"],
  promotionStartDate: ["시작일시", "Start Date", "promotionStartDate"],
  promotionEndDate: ["종료일시", "End Date", "promotionEndDate"],
  exposureArea: ["노출영역", "Exposure Area", "exposureArea"],
  salesAmountKrw: ["매출액", "Sales Amount", "salesAmountKrw"],
  impressions: ["총 노출수", "Impressions", "impressions"],
  orderQuantity: ["주문수량", "Order Quantity", "orderQuantity"],
  saleMethod: ["판매방식", "Sale Method", "saleMethod"],
  requestedAt: ["요청일시", "Requested At", "requestedAt"]
};

const COUPANG_PROMOTION_REQUIRED_VALUE_COLUMNS: CoupangPromotionColumnKey[] = [
  "promotionPriceKrw",
  "promotionStartDate",
  "promotionEndDate"
];

export const COUPANG_PROMOTION_REQUIRED_COLUMNS: string[] = ["productText", ...COUPANG_PROMOTION_REQUIRED_VALUE_COLUMNS];

export class CoupangPromotionXlsxParser {
  async parseBuffer(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buffer));
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { headers: [], rows: [] as ParsedCoupangPromotionRowResult[], missingColumns: COUPANG_PROMOTION_REQUIRED_COLUMNS };
    }

    const { headers, headerRowNumber } = findHeaderRow(worksheet);
    const headerMap = buildHeaderMap(headers);
    const missingColumns = missingRequiredColumns(headerMap);
    const rows: ParsedCoupangPromotionRowResult[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber || isEmptyRow(row)) {
        return;
      }
      const rawRow = rowToRawRow(row, headers);
      rows.push({
        rowNumber,
        rawRow,
        sourceRowHash: hashCoupangPromotionRecord(rawRow),
        ...parseRow(rawRow, headerMap)
      });
    });

    return { headers, rows, missingColumns };
  }
}

export function hashCoupangPromotionRecord(record: unknown) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function parseRow(rawRow: Record<string, string>, headerMap: Map<CoupangPromotionColumnKey, string>) {
  const issues: ParseIssue[] = [];
  const product = requiredProductText(rawRow, headerMap, issues);
  const promotionPriceKrw = requiredNumber(rawRow, headerMap, "promotionPriceKrw", issues);
  const promotionStartDate = requiredDate(rawRow, headerMap, "promotionStartDate", issues);
  const promotionEndDate = requiredDate(rawRow, headerMap, "promotionEndDate", issues);

  if (promotionPriceKrw <= 0) {
    issues.push({
      columnName: COUPANG_PROMOTION_COLUMN_ALIASES.promotionPriceKrw[0],
      errorCode: "INVALID_PROMOTION_PRICE",
      message: "Promotion price must be greater than 0.",
      rawValue: readRaw(rawRow, headerMap, "promotionPriceKrw")
    });
  }
  if (promotionStartDate && promotionEndDate && promotionEndDate < promotionStartDate) {
    issues.push({
      columnName: COUPANG_PROMOTION_COLUMN_ALIASES.promotionEndDate[0],
      errorCode: "INVALID_PROMOTION_DATE_RANGE",
      message: "Promotion end date must be on or after start date.",
      rawValue: readRaw(rawRow, headerMap, "promotionEndDate")
    });
  }

  return {
    parsedRow:
      issues.length > 0 || !promotionStartDate || !promotionEndDate
        ? null
        : {
            sourcePromotionId: optionalText(rawRow, headerMap, "sourcePromotionId"),
            productText: product.productText,
            rawProductName: product.rawProductName,
            rawOptionName: product.rawOptionName,
            optionId: optionalText(rawRow, headerMap, "optionId"),
            originalSalePriceKrw: optionalNumber(rawRow, headerMap, "originalSalePriceKrw"),
            promotionPriceKrw,
            promotionQuantity: optionalNumber(rawRow, headerMap, "promotionQuantity"),
            shippingType: optionalText(rawRow, headerMap, "shippingType"),
            promotionStatus: optionalText(rawRow, headerMap, "promotionStatus"),
            promotionStartDate,
            promotionEndDate,
            rawStartAt: optionalText(rawRow, headerMap, "promotionStartDate"),
            rawEndAt: optionalText(rawRow, headerMap, "promotionEndDate"),
            exposureArea: optionalText(rawRow, headerMap, "exposureArea"),
            salesAmountKrw: optionalNumber(rawRow, headerMap, "salesAmountKrw"),
            impressions: Math.trunc(optionalNumber(rawRow, headerMap, "impressions")),
            orderQuantity: optionalNumber(rawRow, headerMap, "orderQuantity"),
            saleMethod: optionalText(rawRow, headerMap, "saleMethod"),
            requestedAt: optionalDate(rawRow, headerMap, "requestedAt")
          },
    issues
  };
}

function requiredText(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangPromotionColumnKey, string>,
  key: CoupangPromotionColumnKey,
  issues: ParseIssue[]
) {
  const value = optionalText(rawRow, headerMap, key);
  if (!value) {
    issues.push({
      columnName: COUPANG_PROMOTION_COLUMN_ALIASES[key][0],
      errorCode: "REQUIRED",
      message: `${COUPANG_PROMOTION_COLUMN_ALIASES[key][0]} is required.`,
      rawValue: readRaw(rawRow, headerMap, key)
    });
  }
  return value ?? "";
}

function requiredProductText(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangPromotionColumnKey, string>,
  issues: ParseIssue[]
) {
  const combined = optionalText(rawRow, headerMap, "productText");
  if (combined) {
    return { productText: combined, ...splitCombinedProductText(combined) };
  }

  const rawProductName = optionalText(rawRow, headerMap, "rawProductName");
  const rawOptionName = optionalText(rawRow, headerMap, "rawOptionName");
  const productText = `${rawProductName ?? ""} ${rawOptionName ?? ""}`.trim();
  if (productText && rawProductName && rawOptionName) {
    return { productText, rawProductName, rawOptionName };
  }

  issues.push({
    columnName: "등록상품명, 옵션명",
    errorCode: "REQUIRED",
    message: "등록상품명, 옵션명 is required.",
    rawValue: combined ?? productText
  });
  return { productText, rawProductName, rawOptionName };
}

function splitCombinedProductText(productText: string) {
  const separatorIndex = productText.lastIndexOf(",");
  if (separatorIndex < 0) {
    return { rawProductName: productText, rawOptionName: null };
  }
  const rawProductName = productText.slice(0, separatorIndex).trim();
  const rawOptionName = productText.slice(separatorIndex + 1).trim();
  return {
    rawProductName: rawProductName || productText,
    rawOptionName: rawOptionName || null
  };
}

function requiredNumber(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangPromotionColumnKey, string>,
  key: CoupangPromotionColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = parseNumberValue(rawValue, { emptyAs: 0 });
  if (parsed === null) {
    issues.push({
      columnName: COUPANG_PROMOTION_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_NUMBER",
      message: `${COUPANG_PROMOTION_COLUMN_ALIASES[key][0]} must be numeric.`,
      rawValue
    });
    return 0;
  }
  return parsed;
}

function requiredDate(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangPromotionColumnKey, string>,
  key: CoupangPromotionColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = parsePromotionDate(rawValue);
  if (!parsed) {
    issues.push({
      columnName: COUPANG_PROMOTION_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_DATE",
      message: `${COUPANG_PROMOTION_COLUMN_ALIASES[key][0]} must be a valid date.`,
      rawValue
    });
  }
  return parsed;
}

function optionalNumber(rawRow: Record<string, string>, headerMap: Map<CoupangPromotionColumnKey, string>, key: CoupangPromotionColumnKey) {
  return parseNumberValue(readRaw(rawRow, headerMap, key), { emptyAs: 0 }) ?? 0;
}

function optionalDate(rawRow: Record<string, string>, headerMap: Map<CoupangPromotionColumnKey, string>, key: CoupangPromotionColumnKey) {
  return parsePromotionDate(readRaw(rawRow, headerMap, key));
}

function optionalText(rawRow: Record<string, string>, headerMap: Map<CoupangPromotionColumnKey, string>, key: CoupangPromotionColumnKey) {
  const value = readRaw(rawRow, headerMap, key)?.trim();
  return value ? value : null;
}

function readRaw(rawRow: Record<string, string>, headerMap: Map<CoupangPromotionColumnKey, string>, key: CoupangPromotionColumnKey) {
  const header = headerMap.get(key);
  return header ? rawRow[header] : undefined;
}

function parsePromotionDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const input = value.trim();
  const serial = Number(input);
  if (/^\d+(\.\d+)?$/.test(input) && serial > 20_000) {
    return excelSerialDate(serial);
  }
  const normalized = input
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, "")
    .trim();
  return toDateOnly(parseDateString(normalized) ?? normalized);
}

function excelSerialDate(serial: number) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(serial) * 86_400_000);
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  let headers: string[] = [];
  let headerRowNumber = 1;
  worksheet.eachRow((row, rowNumber) => {
    if (headers.length > 0) {
      return;
    }
    const values = rowToValues(row);
    if (values.filter(Boolean).length >= 2) {
      headers = values;
      headerRowNumber = rowNumber;
    }
  });
  return { headers, headerRowNumber };
}

function buildHeaderMap(headers: string[]) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const map = new Map<CoupangPromotionColumnKey, string>();
  for (const key of Object.keys(COUPANG_PROMOTION_COLUMN_ALIASES) as CoupangPromotionColumnKey[]) {
    const header = COUPANG_PROMOTION_COLUMN_ALIASES[key]
      .map(normalizeHeader)
      .map((alias) => normalizedHeaders.get(alias))
      .find((value): value is string => Boolean(value));
    if (header) {
      map.set(key, header);
    }
  }
  return map;
}

function missingRequiredColumns(headerMap: Map<CoupangPromotionColumnKey, string>) {
  const missing = COUPANG_PROMOTION_REQUIRED_VALUE_COLUMNS.filter((key) => !headerMap.has(key));
  const hasProductText = headerMap.has("productText") || (headerMap.has("rawProductName") && headerMap.has("rawOptionName"));
  return hasProductText ? missing : ["productText", ...missing];
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
