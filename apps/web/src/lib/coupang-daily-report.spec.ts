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
  dailyRowNotes,
  filterDailyReportRows,
  filterDailyReportRowsWithSales,
  flattenDailyReportExportRows,
  formatDailyMoney,
  formatDailyProfit,
  formatDailyQuantity,
  formatDailyRatio,
  isDailyGroupExpanded
} from "./coupang-daily-report";

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

describe("Coupang daily report helpers", () => {
  it("hides single products with zero sales on the selected date", () => {
    const zeroSales = product({
      productId: "zero",
      productName: "판매 없음",
      reportedSalesQuantity: 0
    });

    expect(filterDailyReportRowsWithSales([zeroSales, single])).toEqual([single]);
  });

  it("hides zero-sale options and drops groups without any sold options", () => {
    const zeroSales = product({
      productId: "zero",
      productName: "판매 없음",
      groupId: "wavebar",
      groupName: "웨이브 밸런스바",
      reportedSalesQuantity: 0
    });
    const filteredGroup = filterDailyReportRowsWithSales([
      { ...group, children: [black, zeroSales], childProductCount: 2 }
    ]);

    expect(filteredGroup).toMatchObject([
      {
        rowType: "GROUP",
        groupId: "wavebar",
        childProductCount: 1,
        children: [{ productId: "black" }]
      }
    ]);
    expect(filterDailyReportRowsWithSales([
      { ...group, children: [zeroSales], childProductCount: 1 }
    ])).toEqual([]);
  });

  it("keeps the original order and reference for a blank search", () => {
    const rows = [group, single];
    expect(filterDailyReportRows(rows, " \n ")).toBe(rows);
  });

  it("returns a group with every option when the group name matches", () => {
    const result = filterDailyReportRows([group, single], "웨이브");
    expect(result).toEqual([group]);
    expect(result[0]?.rowType === "GROUP" ? result[0].children : []).toEqual([black, beige]);
  });

  it("returns only the matching option with its parent when an option name matches", () => {
    const result = filterDailyReportRows([group, single], "베이지");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      rowType: "GROUP",
      groupId: "wavebar",
      childProductCount: 1,
      children: [{ productId: "beige" }]
    });
  });

  it("finds group and single-product memos case-insensitively", () => {
    const groupResult = filterDailyReportRows([group, single], "리뷰");
    const singleResult = filterDailyReportRows([group, single], "체험단");

    expect(groupResult[0]).toMatchObject({
      rowType: "GROUP",
      children: [{ productId: "black" }]
    });
    expect(singleResult).toEqual([single]);
  });

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
    const result = flattenDailyReportExportRows(summary, [group, single]);
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

  it("does not create export memo rows for blank notes", () => {
    const noMemoGroup = {
      ...group,
      children: [product({ memo: null }), product({ productId: "two", memo: " " })]
    };
    const noMemoSingle = product({ productId: "no-memo", memo: null });
    expect(
      flattenDailyReportExportRows(summary, [noMemoGroup, noMemoSingle])
        .filter((row) => row.rowKind === "기타사항")
    ).toEqual([]);
  });

  it("keeps current and previous export metrics as numbers and memo metrics blank", () => {
    const result = flattenDailyReportExportRows(summary, [group]);
    const groupExport = result[1];
    const memoExport = result.at(-1);

    expect(typeof groupExport?.reportedSalesKrw).toBe("number");
    expect(typeof groupExport?.previousAdSpendKrw).toBe("number");
    expect(typeof groupExport?.roas).toBe("number");
    expect(memoExport?.reportedSalesKrw).toBe("");
    expect(memoExport?.previousMarginKrw).toBe("");
  });

  it("exports known summary margin only when the summary is incomplete", () => {
    const incompleteSummary = {
      ...summary,
      current: { ...summary.current, isComplete: false, marginKrw: null, knownMarginKrw: 123_000 }
    };
    const total = flattenDailyReportExportRows(incompleteSummary, [])[0];
    expect(total).toMatchObject({
      rowKind: "전체합계",
      productName: "계산 가능한 상품 부분 합계 (일부 상품 제외)",
      marginKrw: 123_000
    });
  });

  it("labels a complete export summary as a confirmed full total", () => {
    const total = flattenDailyReportExportRows(summary, [])[0];
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
    const result = flattenDailyReportExportRows({ ...summary, previous }, []);
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
    roas: 5.406,
    organicSalesKrw: 246_000,
    marginKrw: 244_700
  };
}

function previous() {
  return {
    reportedSalesQuantity: 21,
    adSpendKrw: 121_000,
    roas: 5.182,
    marginKrw: 231_800
  };
}

function renderSingle(row: CoupangDailyProductRow) {
  return renderToStaticMarkup(createElement(
    "table",
    null,
    createElement(CoupangDailySingleBody, { row, searchHidden: false })
  ));
}

function renderGroup(row: CoupangDailyGroupRow, expanded = true) {
  return renderToStaticMarkup(createElement(
    "table",
    null,
    createElement(CoupangDailyGroupBody, {
      row,
      visibleRow: row,
      hasQuery: false,
      expanded,
      onToggle: () => undefined
    })
  ));
}
