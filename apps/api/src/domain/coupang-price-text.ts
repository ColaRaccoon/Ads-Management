import { createHash } from "node:crypto";
import { parseNumberValue, ParseIssue } from "./date-number";

export const COUPANG_PRICE_TEXT_SCHEMA_VERSION = 1;

export type ParsedCoupangPriceTextRow = {
  itemName: string;
  salePriceKrw: number;
};

export type ParsedCoupangPriceTextRowResult = {
  rowNumber: number;
  rawLine: string;
  sourceRowHash: string;
  parsedRow: ParsedCoupangPriceTextRow | null;
  issues: ParseIssue[];
};

export class CoupangPriceTextParser {
  parseBuffer(buffer: Buffer) {
    const text = new TextDecoder("utf-8").decode(buffer);
    const rows = text
      .split(/\r?\n/)
      .map((line, index) => parseLine(line, index + 1))
      .filter((row) => row.rawLine.trim());
    return { rows };
  }
}

export function hashCoupangPriceTextRecord(record: unknown) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function parseLine(rawLine: string, rowNumber: number): ParsedCoupangPriceTextRowResult {
  const issues: ParseIssue[] = [];
  const match = rawLine.match(/^\s*(.+?)\s*(?:=|,|\t|\s{2,})\s*([0-9,.\s]+)\s*$/);
  if (!match) {
    return {
      rowNumber,
      rawLine,
      sourceRowHash: hashCoupangPriceTextRecord(rawLine),
      parsedRow: null,
      issues: [
        {
          columnName: "line",
          errorCode: "INVALID_PRICE_TEXT_LINE",
          message: "Expected a product name and price separated by '=', comma, tab, or repeated spaces.",
          rawValue: rawLine
        }
      ]
    };
  }

  const salePriceKrw = parseNumberValue(match[2], { emptyAs: null });
  if (salePriceKrw === null) {
    issues.push({
      columnName: "price",
      errorCode: "INVALID_NUMBER",
      message: "Sale price must be numeric.",
      rawValue: match[2]
    });
  }

  return {
    rowNumber,
    rawLine,
    sourceRowHash: hashCoupangPriceTextRecord(rawLine),
    parsedRow: issues.length > 0 ? null : { itemName: match[1].trim(), salePriceKrw: salePriceKrw ?? 0 },
    issues
  };
}
