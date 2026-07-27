import { describe, expect, it } from "vitest";
import {
  collectDailyRowCategories,
  normalizeDailySearchQuery,
  resolveDailyCategoryScope,
  resolveDailySearchProductIds
} from "./coupang-daily-report-filter";

const categories = [
  {
    id: "home",
    displayName: "홈",
    sortOrder: 20,
    isActive: true,
    members: [{ coupangProductId: "a" }, { coupangProductId: "b" }]
  },
  {
    id: "new",
    displayName: "신제품",
    sortOrder: 10,
    isActive: true,
    members: [{ coupangProductId: "a" }, { coupangProductId: "c" }]
  },
  {
    id: "old",
    displayName: "비활성",
    sortOrder: 1,
    isActive: false,
    members: [{ coupangProductId: "d" }]
  }
];

describe("Coupang daily report product scopes", () => {
  it("uses all products without a category filter", () => {
    expect([...resolveDailyCategoryScope({
      allProductIds: ["a", "b", "c", "d"],
      categories,
      selectedCategoryIds: new Set(),
      includeUncategorized: false
    })]).toEqual(["a", "b", "c", "d"]);
  });

  it("unions overlapping categories and treats inactive-only members as uncategorized", () => {
    const scope = resolveDailyCategoryScope({
      allProductIds: ["a", "b", "c", "d", "e"],
      categories,
      selectedCategoryIds: new Set(["home", "new"]),
      includeUncategorized: true
    });
    expect([...scope].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns a category union without duplicates and allows an explicitly empty category", () => {
    expect([...resolveDailyCategoryScope({
      allProductIds: ["a", "b", "c", "d"],
      categories,
      selectedCategoryIds: new Set(["home", "new"]),
      includeUncategorized: false
    })].sort()).toEqual(["a", "b", "c"]);
    expect([...resolveDailyCategoryScope({
      allProductIds: ["a", "b"],
      categories: [...categories, {
        id: "empty",
        displayName: "빈 분류",
        sortOrder: 30,
        isActive: true,
        members: []
      }],
      selectedCategoryIds: new Set(["empty"]),
      includeUncategorized: false
    })]).toEqual([]);
  });

  it("selects only uncategorized products and ignores inactive-category membership", () => {
    expect([...resolveDailyCategoryScope({
      allProductIds: ["a", "b", "c", "d", "e"],
      categories,
      selectedCategoryIds: new Set(),
      includeUncategorized: true
    })].sort()).toEqual(["d", "e"]);
  });

  it("matches a group only inside the selected scope and also matches normalized memos", () => {
    const products = [
      { id: "a", displayName: "검정", group: { id: "g", displayName: "웨이브 바" } },
      { id: "b", displayName: "베이지", group: { id: "g", displayName: "웨이브 바" } },
      { id: "c", displayName: "웨이브 단일", group: null }
    ];
    expect([...resolveDailySearchProductIds({
      products,
      manualPurchases: [],
      scopedProductIds: new Set(["a"]),
      query: normalizeDailySearchQuery("  웨이브  ")
    })]).toEqual(["a"]);
    expect([...resolveDailySearchProductIds({
      products,
      manualPurchases: [{ coupangProductId: "b", memo: "  리뷰   집중  " }],
      scopedProductIds: new Set(["b"]),
      query: normalizeDailySearchQuery("리뷰 집중")
    })]).toEqual(["b"]);
    expect([...resolveDailySearchProductIds({
      products,
      manualPurchases: [{ coupangProductId: "c", memo: "리뷰 집중" }],
      scopedProductIds: new Set(["a", "b"]),
      query: normalizeDailySearchQuery("베이지")
    })]).toEqual(["b"]);
    expect([...resolveDailySearchProductIds({
      products,
      manualPurchases: [{ coupangProductId: "c", memo: "리뷰 집중" }],
      scopedProductIds: new Set(["a", "b"]),
      query: normalizeDailySearchQuery("리뷰")
    })]).toEqual([]);
  });

  it("deduplicates and sorts row category references", () => {
    expect(collectDailyRowCategories(["a", "a"], categories)).toEqual([
      { id: "new", displayName: "신제품" },
      { id: "home", displayName: "홈" }
    ]);
  });
});
