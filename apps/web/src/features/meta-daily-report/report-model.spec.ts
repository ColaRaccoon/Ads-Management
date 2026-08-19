import { describe, expect, it } from "vitest";
import type { MetaCreativePerformanceRow } from "@/types/meta";
import {
  aggregateProductRows,
  buildPreviousIndexes,
  buildReportProductGroups,
  buildSalesProductIndex,
  filterRows,
  findPreviousRow,
  findSalesRowForGroup,
  groupRowsByProduct,
  normalizeLookupText,
  toggleColumn
} from "./report-model";
import type { ProductGroup, SalesProductRow } from "./types";

describe("meta daily report model", () => {
  it("filters only positive current spend for hasSpend", () => {
    const rows = [creative({ creativeKey: "positive", spendUsd: 1 }), creative({ creativeKey: "zero" })];

    expect(filterRows(rows, "hasSpend").map((row) => row.creativeKey)).toEqual(["positive"]);
    expect(filterRows(rows, "active")).toBe(rows);
  });

  it("groups by product id before normalized product name and preserves creative ordering", () => {
    const rows = [
      creative({ creativeKey: "inactive", productId: "p1", productName: "첫 이름", deliveryStatus: "inactive", spendUsd: 50 }),
      creative({ creativeKey: "active", productId: "p1", productName: "바뀐 이름", deliveryStatus: "active", spendUsd: 10 }),
      creative({ creativeKey: "name-1", productId: null, productName: "  이름 없는 상품 ", spendUsd: 5 }),
      creative({ creativeKey: "name-2", productId: null, productName: "이름없는상품", spendUsd: 4 })
    ];

    const groups = groupRowsByProduct(rows);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ productId: "p1", productName: "첫 이름" });
    expect(groups[0].rows.map((row) => row.creativeKey)).toEqual(["active", "inactive"]);
    expect(groups[1].rows.map((row) => row.creativeKey)).toEqual(["name-1", "name-2"]);
  });

  it("propagates unknown KRW totals only when corresponding activity exists", () => {
    const totals = aggregateProductRows([
      creative({ spendUsd: 10, spendKrw: null, purchaseCount: 1, revenueKrw: null }),
      creative({ spendUsd: 0, spendKrw: null, purchaseCount: 0, revenueKrw: null })
    ]);

    expect(totals).toEqual({
      spendUsd: 10,
      spendKrw: null,
      purchaseCount: 1,
      cpaUsd: 10,
      cpaKrw: null,
      revenueKrw: null,
      roas: null
    });
    expect(aggregateProductRows([creative({ spendKrw: null, revenueKrw: null })])).toMatchObject({
      spendKrw: 0,
      revenueKrw: 0
    });
  });

  it("indexes product aliases and refuses ambiguous name matches", () => {
    const first = sales({ productId: "p1", product: { displayName: "공통 상품", name: "상품 1" } });
    const second = sales({ productId: "p2", product: { displayName: "공통상품", code: "CODE-2" } });
    const index = buildSalesProductIndex([first, second]);

    expect(index.byProductName.get("공통상품")).toMatchObject({ row: first, ambiguous: true });
    expect(findSalesRowForGroup(productGroup({ productName: " 공통 상품 " }), index)).toBeNull();
    expect(findSalesRowForGroup(productGroup({ productId: "p2", productName: "공통 상품" }), index)).toBe(second);
  });

  it("joins matched sales rows and appends active sales-only groups filtered by normalized query", () => {
    const matched = sales({ productId: "p1", quantity: 1, product: { displayName: "메타 상품" } });
    const salesOnly = sales({ productId: "p2", quantity: 2, product: { displayName: " 검색 상품 " } });
    const inactive = sales({ productId: "p3", product: { displayName: "검색 결과 없음" } });
    const groups = buildReportProductGroups(
      [productGroup({ productId: "p1", productName: "메타 상품", rows: [creative({ spendUsd: 1 })] })],
      [matched, salesOnly, inactive],
      buildSalesProductIndex([matched, salesOnly, inactive]),
      "검 색"
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ productId: "p1", salesRow: matched, salesOnly: false });
    expect(groups[1]).toMatchObject({ productId: "p2", salesRow: salesOnly, salesOnly: true });
    expect(groups[1].rows).toEqual([]);
  });

  it("matches previous rows by creative key, then product and material, then display name", () => {
    const byCreative = creative({ creativeKey: "same-key", displayName: "other", productName: "other", materialNo: "other" });
    const byMaterial = creative({ creativeKey: "material-key", displayName: "other-2", productName: "상품", materialNo: "01" });
    const byName = creative({ creativeKey: "name-key", displayName: "표시명", productName: null, materialNo: null });
    const indexes = buildPreviousIndexes([byCreative, byMaterial, byName]);

    expect(findPreviousRow(creative({ creativeKey: "same-key", displayName: "표시명", productName: "상품", materialNo: "01" }), indexes)).toBe(byCreative);
    expect(findPreviousRow(creative({ creativeKey: "new", displayName: "표시명", productName: " 상품 ", materialNo: "01" }), indexes)).toBe(byMaterial);
    expect(findPreviousRow(creative({ creativeKey: "new", displayName: "표시명", productName: null, materialNo: null }), indexes)).toBe(byName);
  });

  it("keeps at least one visible column and appends newly enabled keys", () => {
    expect(toggleColumn(["creative"], "creative")).toEqual(["creative"]);
    expect(toggleColumn(["creative", "status"], "creative")).toEqual(["status"]);
    expect(toggleColumn(["status"], "creative")).toEqual(["status", "creative"]);
  });

  it("normalizes whitespace and case for lookup queries", () => {
    expect(normalizeLookupText("  Pro Duct\n01 ")).toBe("product01");
  });
});

type CreativeOverrides = Partial<Omit<MetaCreativePerformanceRow, "totals">> & {
  spendUsd?: number;
  spendKrw?: number | null;
  purchaseCount?: number;
  revenueKrw?: number | null;
};

function creative(overrides: CreativeOverrides = {}): MetaCreativePerformanceRow {
  return {
    creativeKey: overrides.creativeKey ?? "creative",
    displayName: overrides.displayName ?? overrides.creativeKey ?? "소재",
    productName: overrides.productName === undefined ? "상품" : overrides.productName,
    productId: overrides.productId === undefined ? "product" : overrides.productId,
    materialNo: overrides.materialNo === undefined ? "01" : overrides.materialNo,
    deliveryStatus: overrides.deliveryStatus === undefined ? "active" : overrides.deliveryStatus,
    dataDays: overrides.dataDays ?? 1,
    totals: {
      spendUsd: overrides.spendUsd ?? 0,
      spendKrw: overrides.spendKrw === undefined ? 0 : overrides.spendKrw,
      purchaseCount: overrides.purchaseCount ?? 0,
      cpaUsd: null,
      cpaKrw: null,
      ctrLinkPct: null,
      cpmUsd: null,
      roas: null,
      revenueKrw: overrides.revenueKrw === undefined ? 0 : overrides.revenueKrw,
      marginKrw: 0,
      reach: 0,
      videoPlay3sCount: null,
      videoPlay25Count: null,
      videoPlay50Count: null,
      videoPlay75Count: null,
      videoPlay100Count: null,
      videoPlay3sRatePct: null,
      videoPlay25RatePct: null,
      videoPlay50RatePct: null,
      videoPlay75RatePct: null,
      videoPlay100RatePct: null
    }
  };
}

function sales(overrides: Partial<SalesProductRow> = {}): SalesProductRow {
  return {
    productId: "product",
    product: null,
    quantity: 0,
    revenueKrw: 0,
    totalPaidKrw: 0,
    adSpendUsd: 0,
    adSpendKrw: 0,
    grossCostKrw: 0,
    totalCostKrw: 0,
    marginBeforeCouponKrw: 0,
    couponDeductionKrw: 0,
    marginKrw: 0,
    marginRate: null,
    matchedSalesLineCount: 0,
    couponOrderCount: 0,
    couponExactOrderCount: 0,
    couponEstimatedOrderCount: 0,
    couponUnmatchedOrderCount: 0,
    couponIgnoredResidualKrw: 0,
    ...overrides
  };
}

function productGroup(overrides: Partial<ProductGroup> = {}): ProductGroup {
  const rows = overrides.rows ?? [];
  return {
    productName: "상품",
    productId: null,
    rows,
    totals: aggregateProductRows(rows),
    ...overrides
  };
}
