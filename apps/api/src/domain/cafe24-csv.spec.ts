import { describe, expect, it } from "vitest";
import { encode } from "iconv-lite";
import {
  Cafe24CsvHeaderValidator,
  Cafe24CsvParser,
  CAFE24_ORDER_COLUMN_ALIASES,
  CAFE24_ORDER_REQUIRED_COLUMNS,
  CAFE24_ORDER_SCHEMA_VERSION
} from "./cafe24-csv";
import { formatDateOnly } from "./date-number";

describe("Cafe24CsvParser", () => {
  const parser = new Cafe24CsvParser();

  it("parses required Cafe24 columns and keeps zero total paid rows", () => {
    const csv = [
      csvLine([...CAFE24_ORDER_REQUIRED_COLUMNS, "수령인", "수령인 휴대전화", "수령인 주소"]),
      csvLine([
        "20260611-000001",
        "20260611-000001-01",
        "0",
        "120",
        "버닝 웨이브 바 배틀로프",
        "버닝 웨이브 바 배틀로프 [옵션: 블랙+그레이]",
        "2",
        "38,900",
        "카드",
        "2026-06-11 10:20:30",
        "홍길동",
        "010-0000-0000",
        "서울시 어딘가"
      ])
    ].join("\n");

    const { headers, rows } = parser.parseBuffer(Buffer.from(csv, "utf8"));
    const parsed = parser.parseRow(rows[0]);
    const sanitized = parser.sanitizedRawRow(rows[0]);

    expect(Cafe24CsvHeaderValidator.validate(headers).valid).toBe(true);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.parsedRow?.quantity).toBe(2);
    expect(parsed.parsedRow?.totalPaidKrw).toBe(0);
    expect(parsed.parsedRow?.totalOrderKrw).toBeNull();
    expect(parsed.parsedRow?.salePriceKrw).toBe(38900);
    expect(parsed.parsedRow?.orderDate ? formatDateOnly(parsed.parsedRow.orderDate) : null).toBe("2026-06-11");
    expect(Object.keys(sanitized)).not.toContain("수령인 휴대전화");
    expect(Object.keys(sanitized)).not.toContain("수령인 주소");
    expect(sanitized["주문번호"]).toBe("20260611-000001");
  });

  it("parses and sanitizes total order amount and exposes coupon-ready schema v2 preview", () => {
    const csv = [
      csvLine([...CAFE24_ORDER_REQUIRED_COLUMNS, CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]]),
      csvLine([...requiredRowValues(), "90,000"])
    ].join("\n");
    const buffer = Buffer.from(csv, "utf8");
    const { headers, rows } = parser.parseBuffer(buffer);
    const parsed = parser.parseRow(rows[0]);
    const preview = parser.preview(buffer);

    expect(CAFE24_ORDER_SCHEMA_VERSION).toBe(2);
    expect(Cafe24CsvHeaderValidator.validate(headers)).toEqual({ valid: true, missingColumns: [] });
    expect(parsed.issues).toEqual([]);
    expect(parsed.parsedRow?.totalOrderKrw).toBe(90000);
    expect(parser.sanitizedRawRow(rows[0])[CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]]).toBe("90,000");
    expect(preview).toMatchObject({
      schemaVersion: 2,
      couponReady: true,
      couponMissingColumns: [],
      totalOrderKrw: 90000,
      totalOrderKrwIsRowSum: true
    });
    expect(preview.sampleRows[0].totalOrderKrw).toBe(90000);
  });

  it("rejects a blank total paid amount while preserving an explicit zero", () => {
    const headers = [...CAFE24_ORDER_REQUIRED_COLUMNS, CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]];
    const blankValues = requiredRowValues();
    blankValues[2] = "";
    const blank = parser.parseRow(
      parser.parseBuffer(Buffer.from([csvLine(headers), csvLine([...blankValues, "90,000"])].join("\n"))).rows[0]
    );
    const zeroValues = requiredRowValues();
    zeroValues[2] = "0";
    const zero = parser.parseRow(
      parser.parseBuffer(Buffer.from([csvLine(headers), csvLine([...zeroValues, "90,000"])].join("\n"))).rows[0]
    );

    expect(blank.parsedRow).toBeNull();
    expect(blank.issues).toEqual([
      expect.objectContaining({
        columnName: CAFE24_ORDER_COLUMN_ALIASES.totalPaidKrw[0],
        errorCode: "INVALID_NUMBER"
      })
    ]);
    expect(zero.issues).toEqual([]);
    expect(zero.parsedRow?.totalPaidKrw).toBe(0);
  });

  it("keeps the legacy required-header contract when total order amount is absent", () => {
    const csv = [csvLine(CAFE24_ORDER_REQUIRED_COLUMNS), csvLine(requiredRowValues())].join("\n");
    const buffer = Buffer.from(csv, "utf8");
    const { headers, rows } = parser.parseBuffer(buffer);

    expect(Cafe24CsvHeaderValidator.validate(headers)).toEqual({ valid: true, missingColumns: [] });
    expect(parser.parseRow(rows[0])).toMatchObject({ parsedRow: { totalOrderKrw: null }, issues: [] });
    expect(parser.preview(buffer)).toMatchObject({
      schemaVersion: 2,
      couponReady: false,
      couponMissingColumns: [CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]],
      totalOrderKrw: null,
      totalOrderKrwIsRowSum: false
    });
  });

  it("reports invalid and negative total order amounts", () => {
    const headers = [...CAFE24_ORDER_REQUIRED_COLUMNS, CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]];
    const invalidCsv = [csvLine(headers), csvLine([...requiredRowValues(), "not-a-number"])].join("\n");
    const negativeCsv = [csvLine(headers), csvLine([...requiredRowValues(), "-1"])].join("\n");

    expect(parser.parseRow(parser.parseBuffer(Buffer.from(invalidCsv)).rows[0]).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnName: CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0],
          errorCode: "INVALID_NUMBER"
        })
      ])
    );
    expect(parser.parseRow(parser.parseBuffer(Buffer.from(negativeCsv)).rows[0]).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnName: CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0],
          errorCode: "NEGATIVE_TOTAL_ORDER"
        })
      ])
    );
  });

  it("detects CP949 encoded Cafe24 CSV headers", () => {
    const csv = [
      csvLine(CAFE24_ORDER_REQUIRED_COLUMNS),
      csvLine([
        "20260611-000002",
        "20260611-000002-01",
        "38900",
        "121",
        "버닝 슬라이드",
        "버닝 슬라이드 [옵션: 블랙]",
        "1",
        "38,900",
        "무통장",
        "2026. 6. 11. 09:00:00"
      ])
    ].join("\n");

    const parsed = parser.parseBuffer(encode(csv, "cp949"));

    expect(parsed.headers).toContain("주문번호");
    expect(parser.parseRow(parsed.rows[0]).parsedRow?.productNo).toBe("121");
  });

  it("parses the optional total order amount from CP949 CSV", () => {
    const csv = [
      csvLine([...CAFE24_ORDER_REQUIRED_COLUMNS, CAFE24_ORDER_COLUMN_ALIASES.totalOrderKrw[0]]),
      csvLine([...requiredRowValues(), "90,000"])
    ].join("\n");
    const parsed = parser.parseBuffer(encode(csv, "cp949"));

    expect(parser.parseRow(parsed.rows[0]).parsedRow?.totalOrderKrw).toBe(90000);
  });

  it("reports missing required headers", () => {
    const result = Cafe24CsvHeaderValidator.validate(["주문번호", "상품번호"]);

    expect(result.valid).toBe(false);
    expect(result.missingColumns).toContain("품목별 주문번호");
    expect(result.missingColumns).toContain("발주일");
  });
});

function csvLine(values: unknown[]) {
  return values.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
}

function requiredRowValues() {
  return [
    "20260611-000010",
    "20260611-000010-01",
    "85,000",
    "120",
    "Wavebar",
    "Wavebar black",
    "1",
    "90,000",
    "쿠폰,신용카드",
    "2026-06-11 10:20:30"
  ];
}
