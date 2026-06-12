import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { decode } from "iconv-lite";
import { formatDateOnly, ParseIssue, toDateOnly } from "./date-number";

export const CAFE24_ORDER_SCHEMA_VERSION = 1;

export const CAFE24_ORDER_COLUMN_ALIASES = {
  orderNo: ["주문번호", "주문 번호"],
  lineOrderNo: ["품목별 주문번호", "품목별주문번호", "품목 주문번호"],
  totalPaidKrw: ["총 결제금액", "총결제금액", "총 결제 금액"],
  productNo: ["상품번호", "상품 번호"],
  productName: ["주문상품명", "주문 상품명", "상품명"],
  optionName: ["주문상품명(옵션포함)", "주문상품명 (옵션포함)", "주문 상품명(옵션포함)", "옵션포함명"],
  quantity: ["수량", "주문수량", "주문 수량"],
  salePriceKrw: ["판매가", "상품 판매가", "판매가(원)"],
  paymentMethod: ["결제수단", "결제 수단"],
  orderedAt: ["발주일", "발주일시", "주문일시", "주문일"]
} as const;

export const CAFE24_ORDER_REQUIRED_COLUMNS = Object.values(CAFE24_ORDER_COLUMN_ALIASES).map((aliases) => aliases[0]);

export type Cafe24OrderColumnKey = keyof typeof CAFE24_ORDER_COLUMN_ALIASES;

export type ParsedCafe24OrderRow = {
  orderNo: string;
  lineOrderNo: string;
  productNo: string;
  productName: string;
  optionName: string;
  quantity: number;
  salePriceKrw: number;
  totalPaidKrw: number;
  paymentMethod: string | null;
  orderedAt: Date | null;
  orderDate: Date | null;
};

export class Cafe24CsvHeaderValidator {
  static validate(headers: string[]): { valid: boolean; missingColumns: string[] } {
    const missingColumns = (Object.keys(CAFE24_ORDER_COLUMN_ALIASES) as Cafe24OrderColumnKey[])
      .filter((key) => !findHeader(headers, CAFE24_ORDER_COLUMN_ALIASES[key]))
      .map((key) => CAFE24_ORDER_COLUMN_ALIASES[key][0]);

    return { valid: missingColumns.length === 0, missingColumns };
  }
}

export class Cafe24CsvParser {
  parseBuffer(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
    return this.parseDecodedText(this.decodeCsvText(buffer));
  }

  parseHeadersOnly(buffer: Buffer): string[] {
    return this.parseHeadersOnlyText(this.decodeCsvText(buffer));
  }

  preview(buffer: Buffer) {
    const { headers, rows } = this.parseBuffer(buffer);
    const parsedRows = rows.map((row) => this.parseRow(row));
    const validRows = parsedRows.map((row) => row.parsedRow).filter((row): row is ParsedCafe24OrderRow => Boolean(row));
    const orderDates = validRows
      .map((row) => row.orderDate)
      .filter((date): date is Date => Boolean(date))
      .map(formatDateOnly)
      .sort();

    return {
      schemaVersion: CAFE24_ORDER_SCHEMA_VERSION,
      columnCount: headers.length,
      rowCount: rows.length,
      validRowCount: validRows.length,
      issueCount: parsedRows.reduce((total, row) => total + row.issues.length, 0),
      orderStart: orderDates[0] ?? null,
      orderEnd: orderDates[orderDates.length - 1] ?? null,
      totalQuantity: validRows.reduce((total, row) => total + row.quantity, 0),
      totalPaidKrw: validRows.reduce((total, row) => total + row.totalPaidKrw, 0),
      sampleRows: validRows.slice(0, 5)
    };
  }

  parseRow(rawRow: Record<string, string>): { parsedRow: ParsedCafe24OrderRow | null; issues: ParseIssue[] } {
    const issues: ParseIssue[] = [];
    const orderNo = this.requiredText(rawRow, "orderNo", issues);
    const lineOrderNo = this.requiredText(rawRow, "lineOrderNo", issues);
    const productNo = this.requiredText(rawRow, "productNo", issues);
    const productName = this.requiredText(rawRow, "productName", issues);
    const optionName = this.requiredText(rawRow, "optionName", issues);
    const quantity = this.requiredNumber(rawRow, "quantity", issues);
    const salePriceKrw = this.requiredNumber(rawRow, "salePriceKrw", issues);
    const totalPaidKrw = this.requiredNumber(rawRow, "totalPaidKrw", issues);
    const orderedAt = this.requiredDateTime(rawRow, "orderedAt", issues);
    const orderDate = orderedAt ? toDateOnly(formatDateOnly(orderedAt)) : null;

    if (quantity < 0) {
      issues.push({
        columnName: CAFE24_ORDER_COLUMN_ALIASES.quantity[0],
        errorCode: "NEGATIVE_QUANTITY",
        message: "Cafe24 quantity cannot be negative.",
        rawValue: readColumn(rawRow, "quantity")
      });
    }

    const parsedRow =
      issues.length === 0
        ? {
            orderNo,
            lineOrderNo,
            productNo: normalizeCafe24ProductNoText(productNo),
            productName,
            optionName,
            quantity,
            salePriceKrw,
            totalPaidKrw,
            paymentMethod: textValue(readColumn(rawRow, "paymentMethod")),
            orderedAt,
            orderDate
          }
        : null;

    return { parsedRow, issues };
  }

  sanitizedRawRow(rawRow: Record<string, string>): Record<string, string> {
    return sanitizeCafe24RawRow(rawRow);
  }

  private parseDecodedText(text: string): { headers: string[]; rows: Record<string, string>[] } {
    const rows = parse(text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false
    }) as Record<string, string>[];

    const headers = rows.length > 0 ? Object.keys(rows[0]) : this.parseHeadersOnlyText(text);
    return { headers: headers.map(stripBom), rows };
  }

  private parseHeadersOnlyText(text: string): string[] {
    const records = parse(text, {
      bom: true,
      to_line: 1,
      relax_column_count: true
    }) as string[][];
    return (records[0] ?? []).map(stripBom);
  }

  private decodeCsvText(buffer: Buffer): string {
    const candidates = [
      new TextDecoder("utf-8").decode(buffer),
      decode(buffer, "cp949"),
      decode(buffer, "euc-kr")
    ];

    let bestText = candidates[0];
    let bestScore = -1;
    for (const text of candidates) {
      try {
        const score = headerMatchScore(this.parseHeadersOnlyText(text));
        if (score > bestScore) {
          bestText = text;
          bestScore = score;
        }
      } catch {
        // Keep the best candidate found so far.
      }
    }
    return bestText;
  }

  private requiredText(rawRow: Record<string, string>, key: Cafe24OrderColumnKey, issues: ParseIssue[]): string {
    const value = textValue(readColumn(rawRow, key));
    if (!value) {
      issues.push({
        columnName: CAFE24_ORDER_COLUMN_ALIASES[key][0],
        errorCode: "REQUIRED",
        message: `${CAFE24_ORDER_COLUMN_ALIASES[key][0]} is required.`,
        rawValue: readColumn(rawRow, key)
      });
    }
    return value ?? "";
  }

  private requiredNumber(rawRow: Record<string, string>, key: Cafe24OrderColumnKey, issues: ParseIssue[]): number {
    const rawValue = readColumn(rawRow, key);
    const parsed = parseCafe24Number(rawValue, { emptyAs: 0 });
    if (parsed === null) {
      issues.push({
        columnName: CAFE24_ORDER_COLUMN_ALIASES[key][0],
        errorCode: "INVALID_NUMBER",
        message: `${CAFE24_ORDER_COLUMN_ALIASES[key][0]} must be numeric.`,
        rawValue
      });
      return 0;
    }
    return parsed;
  }

  private requiredDateTime(rawRow: Record<string, string>, key: Cafe24OrderColumnKey, issues: ParseIssue[]): Date | null {
    const rawValue = readColumn(rawRow, key);
    const parsed = parseCafe24DateTime(rawValue);
    if (!parsed) {
      issues.push({
        columnName: CAFE24_ORDER_COLUMN_ALIASES[key][0],
        errorCode: "INVALID_DATE",
        message: `${CAFE24_ORDER_COLUMN_ALIASES[key][0]} must be a valid date or datetime.`,
        rawValue
      });
    }
    return parsed;
  }
}

export function cafe24OrderLineKey(row: ParsedCafe24OrderRow): string {
  return [row.orderNo, row.lineOrderNo, row.productNo, row.optionName].map((value) => value.trim()).join(":");
}

export function hashCafe24Record(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export function sanitizeCafe24RawRow(rawRow: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of Object.keys(CAFE24_ORDER_COLUMN_ALIASES) as Cafe24OrderColumnKey[]) {
    const value = readColumn(rawRow, key);
    if (value !== undefined) {
      sanitized[CAFE24_ORDER_COLUMN_ALIASES[key][0]] = value;
    }
  }
  return sanitized;
}

export function parseCafe24Number(value: string | number | null | undefined, options: { emptyAs: 0 | null }): number | null {
  if (value === null || value === undefined) {
    return options.emptyAs;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : options.emptyAs;
  }
  const input = value.trim();
  if (!input || input === "-") {
    return options.emptyAs;
  }
  const negative = /^\(.+\)$/.test(input);
  const cleaned = input.replace(/[,\s₩원$]/g, "").replace(/^\((.+)\)$/, "$1");
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

export function parseCafe24DateTime(value: string | null | undefined): Date | null {
  const input = value?.trim();
  if (!input) {
    return null;
  }

  const match = input.match(
    /^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\.?\s*(?:T|\s)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date;
}

export function readCafe24ColumnValue(rawRow: Record<string, string>, key: Cafe24OrderColumnKey): string | undefined {
  return readColumn(rawRow, key);
}

function readColumn(rawRow: Record<string, string>, key: Cafe24OrderColumnKey): string | undefined {
  const actualHeader = findHeader(Object.keys(rawRow), CAFE24_ORDER_COLUMN_ALIASES[key]);
  return actualHeader ? rawRow[actualHeader] : undefined;
}

function findHeader(headers: string[], aliases: readonly string[]): string | null {
  const byNormalizedHeader = new Map(headers.map((header) => [normalizeHeader(header), header]));
  for (const alias of aliases) {
    const header = byNormalizedHeader.get(normalizeHeader(alias));
    if (header) {
      return header;
    }
  }
  return null;
}

function headerMatchScore(headers: string[]) {
  return (Object.keys(CAFE24_ORDER_COLUMN_ALIASES) as Cafe24OrderColumnKey[]).filter((key) =>
    findHeader(headers, CAFE24_ORDER_COLUMN_ALIASES[key])
  ).length;
}

function normalizeHeader(value: string) {
  return stripBom(value).replace(/\s+/g, "").trim();
}

function stripBom(value: string) {
  return value.replace(/^\uFEFF/, "");
}

function textValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeCafe24ProductNoText(value: string) {
  const trimmed = value.trim();
  return trimmed.endsWith(".0") ? trimmed.slice(0, -2) : trimmed;
}

function isPersonalInfoHeader(header: string) {
  const normalized = normalizeHeader(header);
  return [
    "수령인",
    "받는분",
    "주문자명",
    "주문자",
    "휴대전화",
    "휴대폰",
    "전화번호",
    "전화",
    "주소",
    "우편",
    "이메일",
    "메일",
    "개인통관",
    "통관",
    "송장",
    "배송메시지",
    "배송메세지"
  ].some((pattern) => normalized.includes(pattern));
}
