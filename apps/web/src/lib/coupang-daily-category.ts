export function canonicalDailyCategoryIds(ids: Iterable<string>) {
  return [...new Set(ids)].sort();
}

export function normalizeDailyReportQuery(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

export function buildCoupangDailyReportUrl(input: {
  date: string; categoryIds: Iterable<string>; includeUncategorized: boolean; query: string;
}) {
  const params = new URLSearchParams({ date: input.date });
  const ids = canonicalDailyCategoryIds(input.categoryIds);
  if (ids.length) params.set("categoryIds", ids.join(","));
  if (input.includeUncategorized) params.set("includeUncategorized", "true");
  const query = normalizeDailyReportQuery(input.query);
  if (query) params.set("q", query);
  return `/coupang/daily-report?${params.toString()}`;
}

export function dailyReportFilenameSlug(label: string, categoryCount: number) {
  const source = categoryCount > 2 ? `카테고리${categoryCount}개` : label;
  return source.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "전체";
}

export function categoryTreeState(childIds: string[], selected: ReadonlySet<string>) {
  const count = childIds.filter((id) => selected.has(id)).length;
  return { checked: childIds.length > 0 && count === childIds.length, indeterminate: count > 0 && count < childIds.length };
}

export type DailyCategoryPopoverCloseReason =
  | "escape"
  | "apply"
  | "outside"
  | "trigger"
  | "manage";

export function shouldRestoreDailyCategoryTriggerFocus(
  reason: DailyCategoryPopoverCloseReason
) {
  return reason === "escape" || reason === "apply";
}

export function planDailyCategoryDeactivation(
  selectedCategoryIds: ReadonlySet<string>,
  categoryId: string
) {
  const selected = new Set(selectedCategoryIds);
  const selectionChanged = selected.delete(categoryId);
  return {
    selected,
    selectionChanged,
    invalidateCurrentReport: !selectionChanged
  };
}
