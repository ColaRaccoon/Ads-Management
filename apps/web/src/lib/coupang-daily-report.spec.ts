import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CoupangDailyGroupBody,
  CoupangDailySingleBody
} from "../app/coupang/daily-report/rows";
import type {
  CoupangDailyGroupRow,
  CoupangDailyProductRow,
  CoupangDailyReportResponse
} from "@/types/coupang";
import {
  COUPANG_DAILY_CSV_COLUMNS,
  dailyRowNotes,
  flattenDailyReportExportRows,
  formatDailyMoney,
  formatDailyProfit,
  formatDailyQuantity,
  formatDailyRatio,
  isDailyGroupExpanded
} from "./coupang-daily-report";
import { serializeCsv } from "./csv";

const black = product({
  productId: "black",
  productName: "블랙",
  groupId: "wavebar",
  groupName: "웨이브 밸런스바",
  memo: " 리뷰 보강 "
});
const beige = product({
  productId: "beige",
  productName: "베이지",
  groupId: "wavebar",
  groupName: "웨이브 밸런스바",
  memo: null
});
const group: CoupangDailyGroupRow = {
  rowType: "GROUP",
  groupId: "wavebar",
  groupName: "웨이브 밸런스바",
  productName: "웨이브 밸런스바",
  reportCategories: [],
  childProductCount: 2,
  children: [black, beige],
  ...metrics(),
  previous: previous(),
  calculationStatus: "COMPLETE",
  warnings: []
};
const single = product({
  productId: "mat",
  productName: "논슬립 슬라이드 매트",
  memo: "신규 상품 체험단"
});
const summary: CoupangDailyReportResponse["summary"] = {
  current: {
    ...metrics(),
    isComplete: true,
    knownMarginKrw: 244_700,
    incompleteProductCount: 0,
    excludedNetSalesKrw: 0,
    excludedSalesQuantity: 0
  },
  previous: {
    ...metrics({
      reportedSalesKrw: 800_000,
      reportedSalesQuantity: 21,
      manualPurchaseQuantity: 0,
      adSpendKrw: 121_000,
      roas: 5.182,
      organicSalesKrw: 220_000,
      marginKrw: 231_800
    }),
    isComplete: true,
    knownMarginKrw: 231_800,
    incompleteProductCount: 0,
    excludedNetSalesKrw: 0,
    excludedSalesQuantity: 0
  }
};

function dailyResponse({
  nextSummary = summary,
  rows = [group, single]
}: {
  nextSummary?: CoupangDailyReportResponse["summary"];
  rows?: CoupangDailyReportResponse["rows"];
} = {}): CoupangDailyReportResponse {
  return {
    date: "2026-07-24",
    previousDate: "2026-07-23",
    appliedFilter: {
      mode: "ALL",
      categories: [],
      includeUncategorized: false,
      query: null,
      matchedCatalogProductCount: 3,
      activityProductCount: 3,
      label: "전체 제품"
    },
    summary: nextSummary,
    rows
  };
}

describe("Coupang daily report helpers", () => {
  it("collects nonblank group notes in displayed option order", () => {
    const whitespaceMemo = product({
      productId: "white",
      productName: "화이트",
      groupId: "wavebar",
      groupName: "웨이브 밸런스바",
      memo: " \t\n "
    });
    expect(dailyRowNotes({ ...group, children: [beige, black, whitespaceMemo] })).toEqual([
      { productName: "블랙", memo: "리뷰 보강" }
    ]);
  });

  it("rejects null, empty, and whitespace-only single-product memos", () => {
    for (const memo of [null, "", " \t\n "]) {
      expect(dailyRowNotes(product({ memo }))).toEqual([]);
    }
  });

  it("temporarily expands a searched group without mutating collapsed state", () => {
    const collapsed = new Set(["wavebar"]);
    expect(isDailyGroupExpanded("wavebar", collapsed, false)).toBe(false);
    expect(isDailyGroupExpanded("wavebar", collapsed, true)).toBe(true);
    expect(collapsed).toEqual(new Set(["wavebar"]));
  });

  it("flattens hierarchy in summary, group, option, memo, and single order", () => {
    const result = flattenDailyReportExportRows(dailyResponse());
    expect(result.map((row) => row.rowKind)).toEqual([
      "전체합계",
      "그룹합계",
      "옵션",
      "옵션",
      "기타사항",
      "단일제품",
      "기타사항"
    ]);
    expect(result[4]?.productName).toBe("기타사항: 블랙 리뷰 보강");
    expect(result[6]?.productName).toBe("기타사항: 신규 상품 체험단");
  });

  it("preserves prior sales and assigns stable visual metadata by top-level product block", () => {
    const result = flattenDailyReportExportRows(dailyResponse());

    expect(result.map((row) => ({
      kind: row.rowKind,
      previousSales: row.previousReportedSalesKrw,
      previousManualPurchases: row.previousManualPurchaseQuantity,
      key: row.visualBlockKey,
      index: row.visualBlockIndex,
      indent: row.indentLevel,
      children: row.visualChildProductCount
    }))).toEqual([
      {
        kind: "전체합계",
        previousSales: 800_000,
        previousManualPurchases: 0,
        key: null,
        index: null,
        indent: 0,
        children: null
      },
      {
        kind: "그룹합계",
        previousSales: 810_000,
        previousManualPurchases: 2,
        key: "group:wavebar",
        index: 0,
        indent: 0,
        children: 2
      },
      {
        kind: "옵션",
        previousSales: 810_000,
        previousManualPurchases: 2,
        key: "group:wavebar",
        index: 0,
        indent: 1,
        children: null
      },
      {
        kind: "옵션",
        previousSales: 810_000,
        previousManualPurchases: 2,
        key: "group:wavebar",
        index: 0,
        indent: 1,
        children: null
      },
      {
        kind: "기타사항",
        previousSales: "",
        previousManualPurchases: "",
        key: "group:wavebar",
        index: 0,
        indent: 0,
        children: null
      },
      {
        kind: "단일제품",
        previousSales: 810_000,
        previousManualPurchases: 2,
        key: "product:mat",
        index: 1,
        indent: 0,
        children: null
      },
      {
        kind: "기타사항",
        previousSales: "",
        previousManualPurchases: "",
        key: "product:mat",
        index: 1,
        indent: 0,
        children: null
      }
    ]);
  });

  it("does not create export memo rows for blank notes", () => {
    const noMemoGroup = {
      ...group,
      children: [product({ memo: null }), product({ productId: "two", memo: " " })]
    };
    const noMemoSingle = product({ productId: "no-memo", memo: null });
    expect(
      flattenDailyReportExportRows(dailyResponse({ rows: [noMemoGroup, noMemoSingle] }))
        .filter((row) => row.rowKind === "기타사항")
    ).toEqual([]);
  });

  it("keeps current and previous export metrics as numbers and memo metrics blank", () => {
    const result = flattenDailyReportExportRows(dailyResponse({ rows: [group] }));
    const groupExport = result[1];
    const memoExport = result.at(-1);

    expect(typeof groupExport?.reportedSalesKrw).toBe("number");
    expect(typeof groupExport?.previousAdSpendKrw).toBe("number");
    expect(typeof groupExport?.roas).toBe("number");
    expect(memoExport?.reportedSalesKrw).toBe("");
    expect(memoExport?.previousMarginKrw).toBe("");
  });

  it("keeps the existing CSV export contract at seventeen columns without visual metadata", () => {
    const result = flattenDailyReportExportRows(dailyResponse({ rows: [group] }));
    const [header, totalRow] = serializeCsv(COUPANG_DAILY_CSV_COLUMNS, result)
      .replace(/^\uFEFF/, "")
      .split("\r\n");

    expect(COUPANG_DAILY_CSV_COLUMNS).toHaveLength(17);
    expect(header).toBe([
      "조회일",
      "선택 필터",
      "검색어",
      "소속 리포트 카테고리",
      "행구분",
      "제품/옵션",
      "쿠팡 원본매출",
      "원본 판매수량",
      "전일 원본 판매수량",
      "가구매수량",
      "광고비(집행상품 기준)",
      "전일 광고비(집행상품 기준)",
      "광고수익률(집행상품 기준)",
      "전일 광고수익률(집행상품 기준)",
      "오가닉 매출(판매상품 기준)",
      "최종 순이익",
      "전일 최종 순이익"
    ].join(","));
    expect(totalRow?.split(",")).toHaveLength(17);
    expect(header).not.toContain("visualBlock");
    expect(header).not.toContain("전일자 매출");
  });

  it("exports known summary margin only when the summary is incomplete", () => {
    const incompleteSummary = {
      ...summary,
      current: { ...summary.current, isComplete: false, marginKrw: null, knownMarginKrw: 123_000 }
    };
    const total = flattenDailyReportExportRows(
      dailyResponse({ nextSummary: incompleteSummary, rows: [] })
    )[0];
    expect(total).toMatchObject({
      rowKind: "전체합계",
      productName: "계산 가능한 상품 부분 합계 (일부 상품 제외)",
      marginKrw: 123_000
    });
  });

  it("labels a complete export summary as a confirmed full total", () => {
    const total = flattenDailyReportExportRows(dailyResponse({ rows: [] }))[0];
    expect(total).toMatchObject({
      rowKind: "전체합계",
      productName: "전체 합계",
      marginKrw: summary.current.marginKrw
    });
  });

  it.each([
    {
      label: "empty",
      previous: { ...summary.previous, isComplete: true, marginKrw: null, knownMarginKrw: 999_000 },
      expected: null
    },
    {
      label: "incomplete",
      previous: { ...summary.previous, isComplete: false, marginKrw: null, knownMarginKrw: 999_000 },
      expected: null
    },
    {
      label: "confirmed zero",
      previous: { ...summary.previous, isComplete: true, marginKrw: 0, knownMarginKrw: 999_000 },
      expected: 0
    }
  ])("exports $label previous margin without a known-margin fallback", ({ previous, expected }) => {
    const result = flattenDailyReportExportRows(
      dailyResponse({ nextSummary: { ...summary, previous }, rows: [] })
    );
    expect(result[0]?.previousMarginKrw).toBe(expected);
  });

  it("hides the product warning icon while preserving the row warning tooltip", () => {
    const html = renderSingle(product({
      calculationStatus: "COMPLETE",
      warnings: ["AD_CONVERSION_EXCEEDS_NET_SALES"]
    }));

    expect(html).not.toContain("coupang-daily-warning-icon");
    expect(html).toContain("계산 경고");
    expect(html).toContain("AD_CONVERSION_EXCEEDS_NET_SALES");
    expect(html).not.toContain("순이익 계산 불완전");
  });

  it("renders the blocking Korean message for a manual purchase without reported sales", () => {
    const html = renderSingle(product({
      calculationStatus: "INCOMPLETE",
      warnings: ["MANUAL_PURCHASE_WITHOUT_REPORTED_SALES"]
    }));

    expect(html).toContain("가구매에 대응하는 쿠팡 원본 판매자료가 없어 손익을 확정할 수 없습니다");
    expect(html).not.toContain("MANUAL_PURCHASE_WITHOUT_REPORTED_SALES");
  });

  it("uses a neutral zero tone instead of the blue ROAS tone when ROAS is zero", () => {
    const html = renderSingle(product({ roas: 0 }));
    expect(html).toContain("0.0%");
    expect(html).toContain("coupang-daily-zero");
    expect(html).not.toContain("coupang-daily-roas");
  });

  it("does not render a memo tr for memo-less single products or groups", () => {
    const singleHtml = renderSingle(product({ memo: null }));
    const groupHtml = renderGroup({
      ...group,
      children: [
        product({ productId: "one", memo: null }),
        product({ productId: "two", memo: " \t " })
      ]
    });

    expect(singleHtml).not.toContain("coupang-daily-memo-row");
    expect(groupHtml).not.toContain("coupang-daily-memo-row");
    expect(singleHtml).not.toContain("기타사항");
    expect(groupHtml).not.toContain("기타사항");
  });

  it("keeps collapsed option and existing memo rows in markup with prefixed collapsed classes", () => {
    const html = renderGroup(group, false);

    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("블랙");
    expect(html).toContain("리뷰 보강");
    expect(html).toContain("coupang-daily-option-row coupang-daily-collapsed");
    expect(html).toContain("coupang-daily-memo-row coupang-daily-collapsed");
  });

  it("formats money, profit, quantity, ratios, zero, negative, and null values", () => {
    expect(formatDailyMoney(1_234_000.4)).toBe("1,234,000원");
    expect(formatDailyMoney(-42_100)).toBe("-42,100원");
    expect(formatDailyMoney(null)).toBe("-");
    expect(formatDailyProfit(353_800)).toBe("+353,800원");
    expect(formatDailyProfit(-42_100)).toBe("-42,100원");
    expect(formatDailyProfit(0)).toBe("0원");
    expect(formatDailyQuantity(1_234)).toBe("1,234개");
    expect(formatDailyRatio(4.61)).toBe("461.0%");
    expect(formatDailyRatio(0)).toBe("0.0%");
    expect(formatDailyRatio(null)).toBe("-");
  });
});

function product(
  overrides: Partial<CoupangDailyProductRow> = {}
): CoupangDailyProductRow {
  return {
    rowType: "PRODUCT",
    productId: "product",
    productName: "상품",
    groupId: null,
    groupName: null,
    reportCategories: [],
    memo: null,
    ...metrics(),
    previous: previous(),
    calculationStatus: "COMPLETE",
    warnings: [],
    ...overrides
  };
}

function metrics(overrides: Partial<ReturnType<typeof metricsBase>> = {}) {
  return { ...metricsBase(), ...overrides };
}

function metricsBase() {
  return {
    reportedSalesKrw: 924_000,
    reportedSalesQuantity: 23,
    manualPurchaseQuantity: 3,
    adSpendKrw: 128_000,
    adGeneratedSalesKrw: 691_968,
    adGeneratedQuantity: 18,
    attributedConversionSalesKrw: 678_000,
    attributedConversionQuantity: 17,
    roas: 5.406,
    organicSalesKrw: 246_000,
    marginKrw: 244_700
  };
}

function previous() {
  return {
    reportedSalesKrw: 810_000,
    reportedSalesQuantity: 21,
    manualPurchaseQuantity: 2,
    adSpendKrw: 121_000,
    adGeneratedSalesKrw: 627_022,
    adGeneratedQuantity: 16,
    attributedConversionSalesKrw: 590_000,
    attributedConversionQuantity: 15,
    roas: 5.182,
    marginKrw: 231_800
  };
}

function renderSingle(row: CoupangDailyProductRow) {
  return renderToStaticMarkup(createElement(
    "table",
    null,
    createElement(CoupangDailySingleBody, { row })
  ));
}

function renderGroup(row: CoupangDailyGroupRow, expanded = true) {
  return renderToStaticMarkup(createElement(
    "table",
    null,
    createElement(CoupangDailyGroupBody, {
      row,
      expanded,
      onToggle: () => undefined
    })
  ));
}
