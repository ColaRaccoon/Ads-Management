import { parse } from "csv-parse/sync";
import { decode } from "iconv-lite";
import { createHash } from "node:crypto";
import { parseNumberValue, ParseIssue } from "./date-number";

export const COUPANG_MARGIN_SCHEMA_VERSION = 2;

export type CoupangMarginColumnKey =
  | "itemName"
  | "salePriceKrw"
  | "supplyPriceKrw"
  | "productCostKrw"
  | "salesFeeRate"
  | "salesFeeKrw"
  | "sellerShippingFeeKrw"
  | "hanaroShippingFeeKrw"
  | "growthInboundFeeKrw"
  | "growthShippingFeeKrw"
  | "returnRate"
  | "returnCostPerUnitKrw"
  | "adEnabled";

export type ParsedCoupangMarginRow = {
  itemName: string;
  salePriceKrw: number;
  supplyPriceKrw: number;
  productCostKrw: number;
  salesFeeRate: number;
  salesFeeKrw: number;
  sellerShippingFeeKrw?: number;
  hanaroShippingFeeKrw: number | null;
  growthInboundFeeKrw: number;
  growthShippingFeeKrw: number;
  returnRate: number;
  returnCostPerUnitKrw: number;
  adEnabled: boolean;
};

export type ParsedCoupangMarginRowResult = {
  rowNumber: number;
  rawRow: Record<string, string>;
  sourceRowHash: string;
  parsedRow: ParsedCoupangMarginRow | null;
  issues: ParseIssue[];
};

export const COUPANG_MARGIN_COLUMN_ALIASES: Record<CoupangMarginColumnKey, string[]> = {
  itemName: ["항목", "품목", "Item", "itemName"],
  salePriceKrw: ["판매가(VAT포함)", "판매가", "Sale Price", "salePriceKrw"],
  supplyPriceKrw: ["공급가", "Supply Price", "supplyPriceKrw"],
  productCostKrw: ["원가", "Product Cost", "productCostKrw"],
  salesFeeRate: ["판매수수료율", "Sales Fee Rate", "salesFeeRate"],
  salesFeeKrw: ["판매수수료", "Sales Fee", "salesFeeKrw"],
  sellerShippingFeeKrw: ["판매자 배송비", "Seller Shipping Fee", "sellerShippingFeeKrw"],
  hanaroShippingFeeKrw: ["하나로 배송비", "Hanaro Shipping Fee", "hanaroShippingFeeKrw"],
  growthInboundFeeKrw: ["그로스 입출고비", "Growth Inbound Fee", "growthInboundFeeKrw"],
  growthShippingFeeKrw: ["그로스 배송비", "Growth Shipping Fee", "growthShippingFeeKrw"],
  returnRate: ["평균 반품률", "Return Rate", "returnRate"],
  returnCostPerUnitKrw: ["반품 1건당 비용", "Return Cost Per Unit", "returnCostPerUnitKrw"],
  adEnabled: ["광고집행(Y/N)", "Ad Enabled", "adEnabled"]
};

export const COUPANG_MARGIN_REQUIRED_COLUMNS: CoupangMarginColumnKey[] = [
  "itemName",
  "salePriceKrw",
  "productCostKrw",
  "salesFeeRate",
  "hanaroShippingFeeKrw",
  "growthInboundFeeKrw",
  "growthShippingFeeKrw"
];

export class CoupangMarginCsvParser {
  parseBuffer(buffer: Buffer) {
    const text = decodeCsvText(buffer);
    const delimiter = detectDelimiter(text);
    const records = parse(text, {
      bom: true,
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false
    }) as Record<string, string>[];
    const headers = records.length > 0 ? Object.keys(records[0]) : parseHeadersOnly(text);
    const headerMap = buildHeaderMap(headers);
    const missingColumns = COUPANG_MARGIN_REQUIRED_COLUMNS.filter((key) => !headerMap.has(key));
    const rows = records.map((rawRow, index): ParsedCoupangMarginRowResult => {
      const parsed = parseRow(rawRow, headerMap);
      return {
        rowNumber: index + 2,
        rawRow,
        sourceRowHash: hashCoupangMarginRecord(rawRow),
        ...parsed
      };
    });
    return { headers, rows, missingColumns };
  }
}

export function hashCoupangMarginRecord(record: unknown) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function parseRow(rawRow: Record<string, string>, headerMap: Map<CoupangMarginColumnKey, string>) {
  const issues: ParseIssue[] = [];
  const itemName = requiredText(rawRow, headerMap, "itemName", issues);
  const salePriceKrw = requiredNumber(rawRow, headerMap, "salePriceKrw", issues);
  const productCostKrw = requiredNumber(rawRow, headerMap, "productCostKrw", issues);
  const returnCostPerUnitKrw = requiredNumber(rawRow, headerMap, "returnCostPerUnitKrw", issues);
  const sellerShippingFeeKrw = logisticsIntegerValue(rawRow, headerMap, "sellerShippingFeeKrw", issues, undefined);
  const hanaroShippingFeeKrw = logisticsIntegerValue(rawRow, headerMap, "hanaroShippingFeeKrw", issues, null);
  const growthInboundFeeKrw = logisticsIntegerValue(rawRow, headerMap, "growthInboundFeeKrw", issues, 0);
  const growthShippingFeeKrw = logisticsIntegerValue(rawRow, headerMap, "growthShippingFeeKrw", issues, 0);

  return {
    parsedRow:
      issues.length > 0
        ? null
        : {
            itemName,
            salePriceKrw,
            supplyPriceKrw: optionalNumber(rawRow, headerMap, "supplyPriceKrw"),
            productCostKrw,
            salesFeeRate: optionalRate(rawRow, headerMap, "salesFeeRate"),
            salesFeeKrw: optionalNumber(rawRow, headerMap, "salesFeeKrw"),
            sellerShippingFeeKrw,
            hanaroShippingFeeKrw,
            growthInboundFeeKrw: growthInboundFeeKrw ?? 0,
            growthShippingFeeKrw: growthShippingFeeKrw ?? 0,
            returnRate: optionalRate(rawRow, headerMap, "returnRate"),
            returnCostPerUnitKrw,
            adEnabled: parseYn(optionalText(rawRow, headerMap, "adEnabled"))
          },
    issues
  };
}

function requiredText(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangMarginColumnKey, string>,
  key: CoupangMarginColumnKey,
  issues: ParseIssue[]
) {
  const value = optionalText(rawRow, headerMap, key);
  if (!value) {
    issues.push({
      columnName: COUPANG_MARGIN_COLUMN_ALIASES[key][0],
      errorCode: "REQUIRED",
      message: `${COUPANG_MARGIN_COLUMN_ALIASES[key][0]} is required.`,
      rawValue: readRaw(rawRow, headerMap, key)
    });
  }
  return value ?? "";
}

function requiredNumber(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangMarginColumnKey, string>,
  key: CoupangMarginColumnKey,
  issues: ParseIssue[]
) {
  const rawValue = readRaw(rawRow, headerMap, key);
  const parsed = parseNumberValue(rawValue, { emptyAs: 0 });
  if (parsed === null) {
    issues.push({
      columnName: COUPANG_MARGIN_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_NUMBER",
      message: `${COUPANG_MARGIN_COLUMN_ALIASES[key][0]} must be numeric.`,
      rawValue
    });
    return 0;
  }
  return parsed;
}

function optionalNumber(rawRow: Record<string, string>, headerMap: Map<CoupangMarginColumnKey, string>, key: CoupangMarginColumnKey) {
  return parseNumberValue(readRaw(rawRow, headerMap, key), { emptyAs: 0 }) ?? 0;
}

function logisticsIntegerValue<T extends number | null | undefined>(
  rawRow: Record<string, string>,
  headerMap: Map<CoupangMarginColumnKey, string>,
  key: CoupangMarginColumnKey,
  issues: ParseIssue[],
  emptyValue: T
): number | T {
  const rawValue = readRaw(rawRow, headerMap, key);
  if (rawValue === undefined || rawValue.trim() === "") {
    return emptyValue;
  }
  const parsed = parseNumberValue(rawValue, { emptyAs: null });
  if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    issues.push({
      columnName: COUPANG_MARGIN_COLUMN_ALIASES[key][0],
      errorCode: "INVALID_NON_NEGATIVE_INTEGER",
      message: `${COUPANG_MARGIN_COLUMN_ALIASES[key][0]} must be a non-negative integer.`,
      rawValue
    });
    return emptyValue;
  }
  return parsed;
}

function optionalRate(rawRow: Record<string, string>, headerMap: Map<CoupangMarginColumnKey, string>, key: CoupangMarginColumnKey) {
  const raw = readRaw(rawRow, headerMap, key);
  const parsed = parseNumberValue(raw, { emptyAs: 0 }) ?? 0;
  return raw?.includes("%") || parsed > 1 ? parsed / 100 : parsed;
}

function optionalText(rawRow: Record<string, string>, headerMap: Map<CoupangMarginColumnKey, string>, key: CoupangMarginColumnKey) {
  const value = readRaw(rawRow, headerMap, key)?.trim();
  return value ? value : null;
}

function readRaw(rawRow: Record<string, string>, headerMap: Map<CoupangMarginColumnKey, string>, key: CoupangMarginColumnKey) {
  const header = headerMap.get(key);
  return header ? rawRow[header] : undefined;
}

function parseYn(value: string | null) {
  const normalized = String(value ?? "Y").trim().toLowerCase();
  return normalized === "y" || normalized === "yes" || normalized === "true" || normalized === "1";
}

function decodeCsvText(buffer: Buffer) {
  const candidates = [new TextDecoder("utf-8").decode(buffer), decode(buffer, "cp949"), decode(buffer, "euc-kr")];
  let bestText = candidates[0];
  let bestScore = -1;
  for (const text of candidates) {
    try {
      const score = headerMatchScore(parseHeadersOnly(text));
      if (score > bestScore) {
        bestText = text;
        bestScore = score;
      }
    } catch {
      // Keep best candidate.
    }
  }
  return bestText;
}

function parseHeadersOnly(text: string) {
  const records = parse(text, { bom: true, delimiter: detectDelimiter(text), to_line: 1, relax_column_count: true }) as string[][];
  return (records[0] ?? []).map((value) => value.replace(/^\uFEFF/, ""));
}

function detectDelimiter(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function buildHeaderMap(headers: string[]) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const map = new Map<CoupangMarginColumnKey, string>();
  for (const key of Object.keys(COUPANG_MARGIN_COLUMN_ALIASES) as CoupangMarginColumnKey[]) {
    const header = COUPANG_MARGIN_COLUMN_ALIASES[key]
      .map(normalizeHeader)
      .map((alias) => normalizedHeaders.get(alias))
      .find((value): value is string => Boolean(value));
    if (header) {
      map.set(key, header);
    }
  }
  return map;
}

function headerMatchScore(headers: string[]) {
  return (Object.keys(COUPANG_MARGIN_COLUMN_ALIASES) as CoupangMarginColumnKey[]).filter((key) =>
    COUPANG_MARGIN_COLUMN_ALIASES[key].some((alias) => headers.map(normalizeHeader).includes(normalizeHeader(alias)))
  ).length;
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim().toLowerCase();
}
