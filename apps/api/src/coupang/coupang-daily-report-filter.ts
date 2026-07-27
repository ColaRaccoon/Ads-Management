import type { ProductProfitRow } from "./coupang.service";

export type DailyCategoryRef = {
  id: string;
  displayName: string;
  sortOrder?: number;
};

export type DailyCategoryWithMembers = DailyCategoryRef & {
  isActive: boolean;
  members: { coupangProductId: string }[];
};

export type DailySearchProduct = {
  id: string;
  displayName: string;
  group?: { id: string; displayName: string } | null;
};

export function normalizeDailySearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
  return normalized || null;
}

export function resolveDailyCategoryScope({
  allProductIds,
  categories,
  selectedCategoryIds,
  includeUncategorized
}: {
  allProductIds: Iterable<string>;
  categories: DailyCategoryWithMembers[];
  selectedCategoryIds: ReadonlySet<string>;
  includeUncategorized: boolean;
}): Set<string> {
  const all = new Set(allProductIds);
  if (selectedCategoryIds.size === 0 && !includeUncategorized) return all;

  const scope = new Set<string>();
  const activeMemberships = new Set<string>();
  for (const category of categories) {
    if (!category.isActive) continue;
    for (const member of category.members) {
      activeMemberships.add(member.coupangProductId);
      if (selectedCategoryIds.has(category.id)) scope.add(member.coupangProductId);
    }
  }
  if (includeUncategorized) {
    for (const productId of all) {
      if (!activeMemberships.has(productId)) scope.add(productId);
    }
  }
  return scope;
}

export function resolveDailySearchProductIds({
  products,
  manualPurchases,
  scopedProductIds,
  query
}: {
  products: DailySearchProduct[];
  manualPurchases: { coupangProductId: string; memo: string | null }[];
  scopedProductIds: ReadonlySet<string>;
  query: string | null;
}): Set<string> {
  if (!query) return new Set(scopedProductIds);
  const result = new Set<string>();
  const matchingGroupIds = new Set(
    products.flatMap((product) => (
      product.group && normalizeDailySearchQuery(product.group.displayName)?.includes(query)
        ? [product.group.id]
        : []
    ))
  );
  for (const product of products) {
    if (!scopedProductIds.has(product.id)) continue;
    if (
      normalizeDailySearchQuery(product.displayName)?.includes(query) ||
      (product.group && matchingGroupIds.has(product.group.id))
    ) {
      result.add(product.id);
    }
  }
  for (const purchase of manualPurchases) {
    if (
      scopedProductIds.has(purchase.coupangProductId) &&
      normalizeDailySearchQuery(purchase.memo)?.includes(query)
    ) {
      result.add(purchase.coupangProductId);
    }
  }
  return result;
}

export function filterProfitRowsByProductIds(
  rows: ProductProfitRow[],
  productIds: ReadonlySet<string>
): ProductProfitRow[] {
  return rows.filter((row) => productIds.has(row.productId));
}

export function collectDailyRowCategories(
  productIds: Iterable<string>,
  categories: DailyCategoryWithMembers[]
): DailyCategoryRef[] {
  const targets = new Set(productIds);
  return categories
    .filter((category) => (
      category.isActive &&
      category.members.some((member) => targets.has(member.coupangProductId))
    ))
    .sort(compareDailyCategories)
    .map(({ id, displayName }) => ({ id, displayName }));
}

export function compareDailyCategories(left: DailyCategoryRef, right: DailyCategoryRef) {
  return (left.sortOrder ?? 100) - (right.sortOrder ?? 100) ||
    left.displayName.localeCompare(right.displayName, "ko-KR") ||
    left.id.localeCompare(right.id);
}
