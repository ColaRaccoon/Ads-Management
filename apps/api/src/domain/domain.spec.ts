import { describe, expect, it } from "vitest";
import { AdsetNameNormalizer } from "./adset-name-normalizer";
import { CsvHeaderValidator, META_ADSET_REQUIRED_COLUMNS, MetaCsvParser } from "./meta-csv";
import { dailyAdMetricKey, MetaAdDailyCsvParser, MetaAdDailyCsvValidator, syntheticAdKey } from "./meta-ad-daily-csv";
import { parseDateString, parseNumberValue } from "./date-number";
import { MarginCalculator } from "./margin-calculator";
import { PeriodMetricCalculator } from "./period-metric-calculator";
import { AdsetProductMatcher, AdsetStageMatcher } from "./matching";
import { DuplicatePolicyResolver } from "./duplicate-policy";
import { DecisionClassifier } from "./decision-classifier";
import { normalizeUploadedFilename } from "../common/encoding";
import { encode } from "iconv-lite";
import { existsSync, readFileSync } from "node:fs";

const SAMPLE_AD_DAILY_CSV =
  "C:/Users/seong/Downloads/Patima-group-파티마그룹-광고-2026.-6.-1.-~-2026.-6.-1. (1).csv";

describe("AdsetNameNormalizer", () => {
  it("trims, collapses spaces, and lowercases keys", () => {
    expect(AdsetNameNormalizer.toKey("  SC   Burning   Wave  ")).toBe("sc burning wave");
  });
});

describe("date and number parsing", () => {
  it("parses supported date formats", () => {
    expect(parseDateString("2026-05-27")).toBe("2026-05-27");
    expect(parseDateString("2026. 5. 27.")).toBe("2026-05-27");
    expect(parseDateString("2026/05/27")).toBe("2026-05-27");
  });

  it("parses numbers without converting percent scale", () => {
    expect(parseNumberValue("", { emptyAs: 0 })).toBe(0);
    expect(parseNumberValue("1,234", { emptyAs: 0 })).toBe(1234);
    expect(parseNumberValue("$12.34", { emptyAs: null })).toBe(12.34);
    expect(parseNumberValue("1.107011%", { emptyAs: null })).toBe(1.107011);
  });
});

describe("CSV header and parser", () => {
  it("reports missing required columns", () => {
    const result = CsvHeaderValidator.validate(["보고 시작"]);
    expect(result.valid).toBe(false);
    expect(result.missingColumns).toContain("광고 세트 이름");
  });

  it("parses a valid row with the required 26 Korean columns", () => {
    expect(META_ADSET_REQUIRED_COLUMNS).toHaveLength(26);
    const row = Object.fromEntries(META_ADSET_REQUIRED_COLUMNS.map((column) => [column, ""]));
    Object.assign(row, {
      "보고 시작": "2026. 5. 27.",
      "보고 종료": "2026/05/27",
      "광고 세트 이름": " SC 버닝웨이브바 ",
      "결과": "2",
      "도달": "1,000",
      "지출 금액 (USD)": "$12.34",
      "노출": "2,000",
      "링크 클릭": "12",
      shop_clicks: "3",
      "클릭(전체)": "20",
      "랜딩 페이지 조회": "4"
    });
    const parsed = new MetaCsvParser().parseRow(row);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.parsedRow?.adsetNameKey).toBe("sc 버닝웨이브바");
    expect(parsed.parsedRow?.spendUsd).toBe(12.34);
  });

  it("parses Korean Excel CSV encoded as EUC-KR/CP949", () => {
    const row = Object.fromEntries(META_ADSET_REQUIRED_COLUMNS.map((column) => [column, ""]));
    Object.assign(row, {
      "보고 시작": "2026. 5. 27.",
      "보고 종료": "2026. 5. 27.",
      "광고 세트 이름": "SC 버닝웨이브바",
      "결과": "2",
      "도달": "1,000",
      "지출 금액 (USD)": "$12.34",
      "노출": "2,000"
    });
    const csv = [
      META_ADSET_REQUIRED_COLUMNS.map(csvCell).join(","),
      META_ADSET_REQUIRED_COLUMNS.map((column) => csvCell(row[column] ?? "")).join(",")
    ].join("\n");
    const parsed = new MetaCsvParser().parseBuffer(encode(csv, "cp949"));

    expect(parsed.headers).toContain("보고 시작");
    expect(parsed.rows[0]["광고 세트 이름"]).toBe("SC 버닝웨이브바");
  });
});

describe("Meta ad daily CSV parser", () => {
  it("validates the 32-column ad-level schema without requiring ad id", () => {
    const headers = [
      "보고 시작",
      "보고 종료",
      "광고 이름",
      "광고 게재",
      "기여 설정",
      "결과",
      "결과 표시 도구",
      "도달",
      "빈도",
      "결과당 비용",
      "광고 세트 예산",
      "광고 세트 예산 유형",
      "지출 금액 (USD)",
      "종료",
      "품질 순위",
      "참여율 순위",
      "전환율 순위",
      "노출",
      "CPM(1,000회 노출당 비용) (USD)",
      "링크 클릭",
      "shop_clicks",
      "CPC(링크 클릭당 비용) (USD)",
      "CTR(링크 클릭률)",
      "클릭(전체)",
      "CTR(전체)",
      "CPC(전체) (USD)",
      "랜딩 페이지 조회",
      "랜딩 페이지 조회당 비용 (USD)",
      "광고 세트 이름",
      "캠페인 이름",
      "광고 세트 ID",
      "캠페인 ID"
    ];

    const result = MetaAdDailyCsvValidator.validate(headers);

    expect(result.valid).toBe(true);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("광고 ID");
  });

  it("keeps Meta IDs as strings and uses a synthetic ad key when ad id is absent", () => {
    const parsed = new MetaAdDailyCsvParser().parseRow({
      "보고 시작": "2026-06-01",
      "보고 종료": "2026-06-01",
      "캠페인 이름": "버닝웨이브바_CBO",
      "캠페인 ID": "120247264695860494",
      "광고 세트 이름": "테스트 광고세트",
      "광고 세트 ID": "120247264695870494",
      "광고 이름": "버닝웨이브바_02",
      "광고 게재": "active",
      "결과": "3",
      "결과 표시 도구": "actions:offsite_conversion.fb_pixel_purchase",
      "지출 금액 (USD)": "$12.34",
      "노출": "1,000"
    });

    expect(parsed.issues).toHaveLength(0);
    expect(parsed.parsedRow?.metaCampaignId).toBe("120247264695860494");
    expect(parsed.parsedRow?.metaAdsetExternalId).toBe("120247264695870494");
    expect(parsed.parsedRow?.syntheticAdKey).toBe(
      syntheticAdKey("120247264695860494", "120247264695870494", "버닝웨이브바_02")
    );
    expect(parsed.parsedRow?.adIdentityKey).toBe(parsed.parsedRow?.syntheticAdKey);
    expect(parsed.parsedRow?.purchaseCount).toBe(3);
  });

  it.runIf(existsSync(SAMPLE_AD_DAILY_CSV))("matches the provided June 1 Meta ad CSV summary", () => {
    const parser = new MetaAdDailyCsvParser();
    const preview = parser.preview(readFileSync(SAMPLE_AD_DAILY_CSV));
    const keys = new Set(preview.sampleRows.map(dailyAdMetricKey));

    expect(preview.rowCount).toBe(38);
    expect(preview.columnCount).toBe(32);
    expect(preview.campaignCount).toBe(5);
    expect(preview.adsetCount).toBe(16);
    expect(preview.uniqueAdNameCount).toBe(33);
    expect(preview.dailyAdKeyCount).toBe(38);
    expect(preview.totalSpendUsd).toBe(142.46);
    expect(preview.totalPurchases).toBe(13);
    expect(preview.duplicateKeys).toHaveLength(0);
    expect(keys.size).toBe(preview.sampleRows.length);
  });
});

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

describe("upload filename encoding", () => {
  it("normalizes UTF-8 Korean filenames decoded as latin1", () => {
    const mojibake = Buffer.from("메타_원천데이터.csv", "utf8").toString("latin1");
    expect(normalizeUploadedFilename(mojibake)).toBe("메타_원천데이터.csv");
    expect(normalizeUploadedFilename("메타_원천데이터.csv")).toBe("메타_원천데이터.csv");
  });
});

describe("MarginCalculator", () => {
  const costRule = {
    salePriceKrw: 50000,
    vatKrw: 5000,
    productCostKrw: 12000,
    shippingKrw: 3000,
    extraCostKrw: 1000
  };

  it("calculates break-even and target/watch/stop CPA", () => {
    const result = new MarginCalculator().thresholds(costRule, {
      targetRatio: 0.8,
      watchRatio: 1.1,
      stopRatio: 1.25
    });
    expect(result.contributionBeforeAdsKrw).toBe(29000);
    expect(result.breakEvenCpaKrw).toBe(29000);
    expect(result.targetCpaKrw).toBe(23200);
    expect(result.watchCpaKrw).toBeCloseTo(31900);
    expect(result.stopCpaKrw).toBe(36250);
  });

  it("calculates margin and CPA", () => {
    const result = new MarginCalculator().margin(
      { spendUsd: 20, purchaseCount: 2, exchangeRateKrwPerUsd: 1371.5 },
      costRule
    );
    expect(result.spendKrw).toBe(27430);
    expect(result.cpaKrw).toBe(13715);
    expect(result.marginKrw).toBe(30570);
  });
});

describe("PeriodMetricCalculator", () => {
  it("recalculates CPA/CTR/CPC from totals instead of averaging daily ratios", () => {
    const result = new PeriodMetricCalculator().calculate([
      { metricDate: "2026-05-27", spendUsd: 10, spendKrw: 13000, resultCount: 1, impressions: 100, linkClicks: 10, clicksAll: 20, landingPageViews: 1 },
      { metricDate: "2026-05-28", spendUsd: 90, spendKrw: 117000, resultCount: 9, impressions: 900, linkClicks: 45, clicksAll: 90, landingPageViews: 2 }
    ]);
    expect(result.cpaUsd).toBe(10);
    expect(result.ctrLinkPct).toBe(5.5);
    expect(result.cpcAllUsd).toBeCloseTo(0.909);
    expect(result.dataDays).toBe(2);
  });
});

describe("matching", () => {
  it("manual history wins over rule priority", () => {
    const result = new AdsetProductMatcher().match(
      "SC 플로우라이트",
      "2026-05-27",
      [{ productId: "manual-product", effectiveFrom: "2026-05-01" }],
      [{ id: "rule-1", productId: "rule-product", matchType: "CONTAINS", pattern: "플로우라이트", priority: 1 }]
    );
    expect(result.productId).toBe("manual-product");
    expect(result.source).toBe("MANUAL");
  });

  it("uses lower priority number first", () => {
    const result = new AdsetProductMatcher().match("CBO 버닝슬라이드", "2026-05-27", [], [
      { id: "late", productId: "late-product", matchType: "CONTAINS", pattern: "버닝", priority: 99 },
      { id: "first", productId: "first-product", matchType: "CONTAINS", pattern: "버닝슬라이드", priority: 1 }
    ]);
    expect(result.productId).toBe("first-product");
    expect(result.matchRuleId).toBe("first");
  });

  it("infers stage only from explicit stage tokens", () => {
    const matcher = new AdsetStageMatcher();
    expect(matcher.match("ASC_broad", "2026-05-27", []).stage).toBe("ASC");
    expect(matcher.match("CBO_scale", "2026-05-27", []).stage).toBe("CBO");
    expect(matcher.match("SC_test", "2026-05-27", []).stage).toBe("SC");
    expect(matcher.match("test_ASC", "2026-05-27", []).stage).toBe("ASC");
    expect(matcher.match("classic scale campaign", "2026-05-27", []).stage).toBe("UNKNOWN");
  });
});

describe("duplicate policy", () => {
  it("skips existing current metric on SKIP policy", () => {
    const result = new DuplicatePolicyResolver().resolve("SKIP", true);
    expect(result.importMetric).toBe(false);
    expect(result.supersedeExisting).toBe(false);
  });

  it("supersedes existing current metric on OVERWRITE", () => {
    const result = new DuplicatePolicyResolver().resolve("OVERWRITE", true);
    expect(result.importMetric).toBe(true);
    expect(result.supersedeExisting).toBe(true);
  });
});

describe("DecisionClassifier", () => {
  it("classifies scale and stage move candidates", () => {
    const decisions = new DecisionClassifier().classify({
      scopeType: "ADSET",
      stage: "SC",
      purchaseCount: 2,
      spendKrw: 30000,
      cpaKrw: 15000,
      marginKrw: 10000,
      dataDays: 2,
      ctrLinkPct: 1.5,
      landingPageViews: 5,
      breakEvenCpaKrw: 25000,
      targetCpaKrw: 20000,
      watchCpaKrw: 27500,
      stopCpaKrw: 31250,
      goodCtrLinkPct: 1,
      goodLandingPageViewCount: 3
    });
    expect(decisions.map((decision) => decision.decision)).toEqual(
      expect.arrayContaining(["SCALE", "SC_TO_CBO", "SC_TO_ASC"])
    );
  });

  it("classifies watch when CPA is within watch CPA", () => {
    const decisions = new DecisionClassifier().classify({
      scopeType: "ADSET",
      stage: "CBO",
      purchaseCount: 1,
      spendKrw: 27000,
      cpaKrw: 27000,
      marginKrw: 1000,
      dataDays: 1,
      ctrLinkPct: 0.8,
      landingPageViews: 1,
      breakEvenCpaKrw: 25000,
      targetCpaKrw: 20000,
      watchCpaKrw: 28000,
      stopCpaKrw: 31250,
      goodCtrLinkPct: 1,
      goodLandingPageViewCount: 3
    });
    expect(decisions.map((decision) => decision.decision)).toContain("WATCH");
  });

  it("classifies stop candidate", () => {
    const decisions = new DecisionClassifier().classify({
      scopeType: "ADSET",
      stage: "ASC",
      purchaseCount: 0,
      spendKrw: 40000,
      cpaKrw: null,
      marginKrw: -40000,
      dataDays: 2,
      ctrLinkPct: 0.2,
      landingPageViews: 0,
      breakEvenCpaKrw: 25000,
      targetCpaKrw: 20000,
      watchCpaKrw: 27500,
      stopCpaKrw: 31250,
      goodCtrLinkPct: 1,
      goodLandingPageViewCount: 3
    });
    expect(decisions.map((decision) => decision.decision)).toContain("STOP_CANDIDATE");
    expect(decisions.map((decision) => decision.decision)).toContain("ASC_TO_SC");
  });
});
