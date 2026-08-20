import { describe, expect, it } from "vitest";
import {
  isPurchaseResult,
  META_AD_DAILY_REQUIRED_COLUMNS,
  MetaAdDailyCsvParser,
  MetaAdDailyCsvValidator
} from "./meta-ad-daily-csv";
import { META_VIDEO_PLAY_COLUMNS } from "./meta-video-metrics";

describe("MetaAdDailyCsvParser purchase result detection", () => {
  it("treats Meta custom offsite conversions as purchase results", () => {
    expect(isPurchaseResult("actions:offsite_conversion.custom.1532866761891806")).toBe(true);
    expect(isPurchaseResult("actions:offsite_conversion.custom.4457913227780992")).toBe(true);
  });
});

describe("MetaAdDailyCsvParser video metrics", () => {
  const parser = new MetaAdDailyCsvParser();

  it("uses the exact five Meta headers and parses a full schema by header name", () => {
    expect(META_VIDEO_PLAY_COLUMNS.map((column) => column.csvColumn)).toEqual([
      "동영상 3초 이상 재생",
      "동영상 25% 재생",
      "동영상 50% 재생",
      "동영상 75% 재생",
      "동영상 100% 재생"
    ]);

    const parsed = parser.parseRow(validRow({
      "알 수 없는 추가 컬럼": "보존 대상",
      "동영상 100% 재생": "2",
      "동영상 50% 재생": "5",
      "동영상 3초 이상 재생": "41",
      "동영상 75% 재생": "2",
      "동영상 25% 재생": "8"
    }));

    expect(parsed.issues).toEqual([]);
    expect(parsed.parsedRow).toMatchObject({
      reach: 84,
      videoPlay3sCount: 41,
      videoPlay25Count: 8,
      videoPlay50Count: 5,
      videoPlay75Count: 2,
      videoPlay100Count: 2
    });
  });

  it("keeps all video counts null when headers are absent or every present cell is empty", () => {
    const legacy = parser.parseRow(validRow());
    const image = parser.parseRow(validRow(Object.fromEntries(
      META_VIDEO_PLAY_COLUMNS.map(({ csvColumn }) => [csvColumn, ""])
    )));

    for (const result of [legacy, image]) {
      expect(result.issues).toEqual([]);
      expect(result.parsedRow).toMatchObject({
        videoPlay3sCount: null,
        videoPlay25Count: null,
        videoPlay50Count: null,
        videoPlay75Count: null,
        videoPlay100Count: null
      });
    }
  });

  it("turns empty cells in a measured row into zero but keeps absent stage headers null", () => {
    const full = parser.parseRow(validRow({
      "동영상 3초 이상 재생": "35",
      "동영상 25% 재생": "5",
      "동영상 50% 재생": "2",
      "동영상 75% 재생": "",
      "동영상 100% 재생": ""
    }));
    const partial = parser.parseRow(validRow({ "동영상 3초 이상 재생": "35" }));

    expect(full.parsedRow).toMatchObject({
      videoPlay3sCount: 35,
      videoPlay25Count: 5,
      videoPlay50Count: 2,
      videoPlay75Count: 0,
      videoPlay100Count: 0
    });
    expect(partial.parsedRow).toMatchObject({
      videoPlay3sCount: 35,
      videoPlay25Count: null,
      videoPlay50Count: null,
      videoPlay75Count: null,
      videoPlay100Count: null
    });
  });

  it("preserves zero, accepts comma counts, and truncates fractions like existing count fields", () => {
    const parsed = parser.parseRow(validRow({
      "동영상 3초 이상 재생": "1,234",
      "동영상 25% 재생": "12.9",
      "동영상 50% 재생": "0",
      "동영상 75% 재생": "13",
      "동영상 100% 재생": "1"
    }));

    expect(parsed.issues).toEqual([]);
    expect(parsed.parsedRow).toMatchObject({
      videoPlay3sCount: 1234,
      videoPlay25Count: 12,
      videoPlay50Count: 0,
      videoPlay75Count: 13,
      videoPlay100Count: 1
    });
  });

  it("reports invalid and negative counts without enforcing stage monotonicity", () => {
    const invalid = parser.parseRow(validRow({
      "동영상 3초 이상 재생": "not-a-number",
      "동영상 25% 재생": "-1"
    }));
    const nonMonotonic = parser.parseRow(validRow({
      "동영상 50% 재생": "5",
      "동영상 75% 재생": "7"
    }));

    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ columnName: "동영상 3초 이상 재생", errorCode: "INVALID_NUMBER" }),
      expect.objectContaining({ columnName: "동영상 25% 재생", errorCode: "NEGATIVE_NUMBER" })
    ]));
    expect(nonMonotonic.issues).toEqual([]);
    expect(nonMonotonic.parsedRow).toMatchObject({ videoPlay50Count: 5, videoPlay75Count: 7 });
  });

  it.each([
    ["NONE", [], META_VIDEO_PLAY_COLUMNS.map((column) => column.csvColumn)],
    ["PARTIAL", ["동영상 3초 이상 재생"], META_VIDEO_PLAY_COLUMNS.slice(1).map((column) => column.csvColumn)],
    ["FULL", META_VIDEO_PLAY_COLUMNS.map((column) => column.csvColumn), []]
  ] as const)("reports %s video schema metadata in validation and preview", (schema, present, missing) => {
    const headers = [...META_AD_DAILY_REQUIRED_COLUMNS, "도달", ...present];
    const validation = MetaAdDailyCsvValidator.validate(headers);
    const preview = parser.preview(csvBuffer(headers, validRow(
      Object.fromEntries(present.map((header) => [header, header === "동영상 3초 이상 재생" ? "1" : ""]))
    )));

    expect(validation.videoMetricSchema).toBe(schema);
    expect(validation.presentVideoColumns).toEqual([...present]);
    expect(validation.missingVideoColumns).toEqual([...missing]);
    expect(preview).toMatchObject({
      videoMetricSchema: schema,
      presentVideoColumns: [...present],
      missingVideoColumns: [...missing]
    });
    expect(validation.warnings.filter((warning) => warning.includes("동영상 재생 컬럼이 일부"))).toHaveLength(
      schema === "PARTIAL" ? 1 : 0
    );
  });
});

describe("MetaAdDailyCsvParser add-to-cart metric", () => {
  const parser = new MetaAdDailyCsvParser();

  it("parses the new Meta add-to-cart column and preserves a real zero", () => {
    expect(parser.parseRow(validRow({ "장바구니에 담기": "1,234" })).parsedRow?.addToCartCount).toBe(1234);
    expect(parser.parseRow(validRow({ "장바구니에 담기": "0" })).parsedRow?.addToCartCount).toBe(0);
    expect(parser.parseRow(validRow({ "장바구니에 담기": "" })).parsedRow?.addToCartCount).toBe(0);
  });

  it("keeps legacy rows without the column unavailable and recommends the new column", () => {
    expect(parser.parseRow(validRow()).parsedRow?.addToCartCount).toBeNull();
    expect(MetaAdDailyCsvValidator.validate([...META_AD_DAILY_REQUIRED_COLUMNS, "도달"]).warnings)
      .toContain("권장 컬럼이 없습니다: 장바구니에 담기");
  });
});

function validRow(overrides: Record<string, string> = {}) {
  return {
    "보고 시작": "2026-08-10",
    "보고 종료": "2026-08-10",
    "캠페인 이름": "캠페인",
    "캠페인 ID": "campaign-1",
    "광고 세트 이름": "광고세트",
    "광고 세트 ID": "adset-1",
    "광고 이름": "260810_소재_01",
    "광고 게재": "active",
    "지출 금액 (USD)": "10.5",
    "노출": "100",
    "도달": "84",
    ...overrides
  };
}

function csvBuffer(headers: readonly string[], row: Record<string, string>) {
  return Buffer.from([
    headers.map(csvCell).join(","),
    headers.map((header) => csvCell(row[header] ?? "")).join(",")
  ].join("\n"), "utf8");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
