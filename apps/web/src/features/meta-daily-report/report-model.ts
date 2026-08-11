import type {
  ColumnKey,
  CreativePerformanceRow,
  DeliveryStatusFilter,
  PreviousIndexes,
  ProductGroup,
  ProductTotals,
  ReportProductGroup,
  SalesProductIndex,
  SalesProductNameMatch,
  SalesProductRow
} from "./types";

export function filterRows(rows: CreativePerformanceRow[], deliveryStatus: DeliveryStatusFilter) {
  return deliveryStatus === "hasSpend"
    ? rows.filter((row) => row.totals.spendUsd > 0)
    : rows;
}

export function groupRowsByProduct(rows: CreativePerformanceRow[]): ProductGroup[] {
  const groups = new Map<string, CreativePerformanceRow[]>();
  for (const row of rows) {
    const key = productGroupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Array.from(groups.values())
    .map((productRows) => ({
      productName: firstNonEmpty(productRows.map((row) => row.productName?.trim())) ?? "제품명 미파싱",
      productId: firstNonNull(productRows.map((row) => row.productId)),
      rows: sortCreativeRows(productRows),
      totals: aggregateProductRows(productRows)
    }))
    .sort((a, b) => {
      const spendDiff = b.totals.spendUsd - a.totals.spendUsd;
      if (spendDiff !== 0) return spendDiff;
      const purchaseDiff = b.totals.purchaseCount - a.totals.purchaseCount;
      if (purchaseDiff !== 0) return purchaseDiff;
      return a.productName.localeCompare(b.productName, "ko-KR", { numeric: true, sensitivity: "base" });
    });
}

export function buildSalesProductIndex(rows: SalesProductRow[]): SalesProductIndex {
  const byProductId = new Map<string, SalesProductRow>();
  const byProductName = new Map<string, SalesProductNameMatch>();
  for (const row of rows) {
    byProductId.set(row.productId, row);
    addSalesProductName(byProductName, row.product?.displayName, row);
    addSalesProductName(byProductName, row.product?.name, row);
    addSalesProductName(byProductName, row.product?.code, row);
  }
  return { byProductId, byProductName };
}

export function buildReportProductGroups(
  productGroups: ProductGroup[],
  salesRows: SalesProductRow[],
  salesProductIndex: SalesProductIndex,
  query: string
): ReportProductGroup[] {
  const matchedSalesProductIds = new Set<string>();
  const groups = productGroups.map((group) => {
    const salesRow = findSalesRowForGroup(group, salesProductIndex);
    if (salesRow) matchedSalesProductIds.add(salesRow.productId);
    return { ...group, salesRow, salesOnly: false };
  });
  const normalizedQuery = normalizeLookupText(query);
  const salesOnlyGroups = salesRows
    .filter((row) => !matchedSalesProductIds.has(row.productId))
    .filter((row) => salesRowMatchesQuery(row, normalizedQuery))
    .sort((a, b) => salesProductLabel(a).localeCompare(
      salesProductLabel(b),
      "ko-KR",
      { numeric: true, sensitivity: "base" }
    ))
    .map((row): ReportProductGroup => ({
      productName: salesProductLabel(row),
      productId: row.productId,
      rows: [],
      totals: emptyProductTotals(),
      salesRow: row,
      salesOnly: true
    }));

  return [...groups, ...salesOnlyGroups].filter(reportGroupHasActivity);
}

export function findSalesRowForGroup(group: ProductGroup, index: SalesProductIndex) {
  if (group.productId) return index.byProductId.get(group.productId) ?? null;
  const nameMatch = index.byProductName.get(normalizeLookupText(group.productName));
  return nameMatch && !nameMatch.ambiguous ? nameMatch.row : null;
}

export function aggregateProductRows(rows: CreativePerformanceRow[]): ProductTotals {
  const spendUsd = sum(rows.map((row) => row.totals.spendUsd));
  const purchaseCount = sum(rows.map((row) => row.totals.purchaseCount));
  const hasUnknownSpendKrw = rows.some(
    (row) => row.totals.spendUsd > 0 && !isKnownNumber(row.totals.spendKrw)
  );
  const hasUnknownRevenueKrw = rows.some(
    (row) => row.totals.purchaseCount > 0 && !isKnownNumber(row.totals.revenueKrw)
  );
  const spendKrw = hasUnknownSpendKrw ? null : sum(rows.map((row) => row.totals.spendKrw));
  const revenueKrw = hasUnknownRevenueKrw ? null : sum(rows.map((row) => row.totals.revenueKrw));
  return {
    spendUsd,
    spendKrw,
    purchaseCount,
    cpaUsd: purchaseCount > 0 ? spendUsd / purchaseCount : null,
    cpaKrw: spendKrw !== null && purchaseCount > 0 ? spendKrw / purchaseCount : null,
    revenueKrw,
    roas: spendKrw !== null && revenueKrw !== null && spendKrw > 0 ? revenueKrw / spendKrw : null
  };
}

export function buildPreviousIndexes(rows: CreativePerformanceRow[]): PreviousIndexes {
  const byCreativeKey = new Map<string, CreativePerformanceRow>();
  const byProductMaterial = new Map<string, CreativePerformanceRow>();
  const byDisplayName = new Map<string, CreativePerformanceRow>();
  for (const row of rows) {
    if (row.creativeKey) byCreativeKey.set(row.creativeKey, row);
    const productMaterialKey = productMaterialLookupKey(row);
    if (productMaterialKey) byProductMaterial.set(productMaterialKey, row);
    if (row.displayName) byDisplayName.set(row.displayName, row);
  }
  return { byCreativeKey, byProductMaterial, byDisplayName };
}

export function findPreviousRow(row: CreativePerformanceRow, indexes: PreviousIndexes) {
  if (row.creativeKey) {
    const byCreativeKey = indexes.byCreativeKey.get(row.creativeKey);
    if (byCreativeKey) return byCreativeKey;
  }
  const productMaterialKey = productMaterialLookupKey(row);
  if (productMaterialKey) {
    const byProductMaterial = indexes.byProductMaterial.get(productMaterialKey);
    if (byProductMaterial) return byProductMaterial;
  }
  return indexes.byDisplayName.get(row.displayName) ?? null;
}

export function toggleColumn(columns: ColumnKey[], key: ColumnKey) {
  if (columns.includes(key)) {
    return columns.length === 1 ? columns : columns.filter((column) => column !== key);
  }
  return [...columns, key];
}

export function reportGroupHasActivity(group: ReportProductGroup) {
  return hasNonZeroNumber(group.totals.spendUsd) ||
    hasNonZeroNumber(group.totals.spendKrw) ||
    hasNonZeroNumber(group.totals.purchaseCount) ||
    hasNonZeroNumber(group.totals.revenueKrw) ||
    salesRowHasActivity(group.salesRow);
}

export function salesProductLabel(row: SalesProductRow) {
  return row.product?.displayName ?? row.product?.name ?? row.product?.code ?? row.productId;
}

export function normalizeLookupText(value: string | null | undefined) {
  return String(value ?? "").trim().split(/\s+/).join("").toLowerCase();
}

export function deliveryStatusClass(value: string | null) {
  const normalized = value?.toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "inactive" || normalized === "not_delivering") return "inactive";
  return "";
}

function salesRowHasActivity(row: SalesProductRow | null) {
  if (!row) return false;
  return hasNonZeroNumber(row.quantity) ||
    hasNonZeroNumber(row.revenueKrw) ||
    hasNonZeroNumber(row.totalPaidKrw) ||
    hasNonZeroNumber(row.adSpendUsd) ||
    hasNonZeroNumber(row.adSpendKrw) ||
    hasNonZeroNumber(row.couponDeductionKrw) ||
    hasNonZeroNumber(row.couponUnmatchedOrderCount);
}

function addSalesProductName(
  index: Map<string, SalesProductNameMatch>,
  value: string | null | undefined,
  row: SalesProductRow
) {
  const key = normalizeLookupText(value);
  if (!key) return;
  const existing = index.get(key);
  if (!existing) {
    index.set(key, { row, ambiguous: false });
  } else if (existing.row.productId !== row.productId) {
    index.set(key, { row: existing.row, ambiguous: true });
  }
}

function salesRowMatchesQuery(row: SalesProductRow, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  return [row.product?.displayName, row.product?.name, row.product?.code, row.productId]
    .some((value) => normalizeLookupText(value).includes(normalizedQuery));
}

function emptyProductTotals(): ProductTotals {
  return {
    spendUsd: 0,
    spendKrw: 0,
    purchaseCount: 0,
    cpaUsd: null,
    cpaKrw: null,
    revenueKrw: 0,
    roas: null
  };
}

function productGroupKey(row: CreativePerformanceRow) {
  if (row.productId) return `id:${row.productId}`;
  const nameKey = normalizeLookupText(row.productName);
  return `name:${nameKey || "제품명 미파싱"}`;
}

function sortCreativeRows(rows: CreativePerformanceRow[]) {
  return [...rows].sort((a, b) => {
    const statusDiff = statusRank(a.deliveryStatus) - statusRank(b.deliveryStatus);
    if (statusDiff !== 0) return statusDiff;
    const spendDiff = b.totals.spendUsd - a.totals.spendUsd;
    if (spendDiff !== 0) return spendDiff;
    const purchaseDiff = b.totals.purchaseCount - a.totals.purchaseCount;
    if (purchaseDiff !== 0) return purchaseDiff;
    return (a.materialNo ?? a.displayName).localeCompare(b.materialNo ?? b.displayName, "ko-KR", {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function productMaterialLookupKey(row: CreativePerformanceRow) {
  if (!row.productName || !row.materialNo) return null;
  return `${row.productName.trim().toLowerCase()}:${row.materialNo.trim().toLowerCase()}`;
}

function statusRank(value: string | null) {
  return deliveryStatusClass(value) === "active" ? 0 : 1;
}

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (isKnownNumber(value) ? value : 0), 0);
}

function isKnownNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && !Number.isNaN(value);
}

function hasNonZeroNumber(value: number | null | undefined) {
  return isKnownNumber(value) && Math.abs(value) > 0;
}

function firstNonNull<T>(values: Array<T | null | undefined>) {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function firstNonEmpty(values: Array<string | null | undefined>) {
  return values.find((value): value is string => Boolean(value)) ?? null;
}
