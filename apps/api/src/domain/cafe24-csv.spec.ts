import { describe, expect, it } from "vitest";
import { encode } from "iconv-lite";
import { Cafe24CsvHeaderValidator, Cafe24CsvParser, CAFE24_ORDER_REQUIRED_COLUMNS } from "./cafe24-csv";
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
    expect(parsed.parsedRow?.salePriceKrw).toBe(38900);
    expect(parsed.parsedRow?.orderDate ? formatDateOnly(parsed.parsedRow.orderDate) : null).toBe("2026-06-11");
    expect(Object.keys(sanitized)).not.toContain("수령인 휴대전화");
    expect(Object.keys(sanitized)).not.toContain("수령인 주소");
    expect(sanitized["주문번호"]).toBe("20260611-000001");
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
