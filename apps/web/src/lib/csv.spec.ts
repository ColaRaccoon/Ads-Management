import { describe, expect, it } from "vitest";
import { serializeCsv } from "./csv";

describe("serializeCsv", () => {
  it("adds a BOM and escapes commas, quotes, and line breaks", () => {
    const csv = serializeCsv(
      [
        { header: "상품명", value: (row: { name: string; note: string }) => row.name },
        { header: "메모", value: (row: { name: string; note: string }) => row.note }
      ],
      [{ name: "쉼표,상품", note: "따옴표 \"와\n줄바꿈" }]
    );

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe('\uFEFF상품명,메모\r\n"쉼표,상품","따옴표 ""와\n줄바꿈"');
  });

  it("exports unavailable amounts as blank cells instead of zero", () => {
    const csv = serializeCsv(
      [{ header: "순이익", value: (row: { margin: number | null }) => row.margin }],
      [{ margin: null }, { margin: 0 }]
    );

    expect(csv).toBe("\uFEFF순이익\r\n\r\n0");
  });

  it("STEP7-EVAL-011 escapes external formula prefixes while preserving numbers", () => {
    const csv = serializeCsv(
      [
        { header: "문자열", value: (row: { value: string; amount: number }) => row.value },
        { header: "숫자", value: (row: { value: string; amount: number }) => row.amount }
      ],
      [
        { value: "=2+2", amount: -12 },
        { value: "+cmd", amount: 0 },
        { value: "-10+20", amount: 3 },
        { value: "@SUM(A1:A2)", amount: 4 },
        { value: " \t=HYPERLINK(\"x\")", amount: 5 }
      ]
    );

    expect(csv).toContain("'=2+2,-12");
    expect(csv).toContain("'+cmd,0");
    expect(csv).toContain("'-10+20,3");
    expect(csv).toContain("'@SUM(A1:A2),4");
    expect(csv).toContain(`"' \t=HYPERLINK(""x"")",5`);
  });
});
