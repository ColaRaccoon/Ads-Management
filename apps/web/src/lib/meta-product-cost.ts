export type MetaProductCostRule = {
  id: string;
  productId: string;
  salePriceKrw: number | string;
  vatKrw: number | string;
  productCostKrw: number | string;
  shippingKrw: number | string;
  extraCostKrw: number | string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  createdAt?: string | null;
};

export function currentMetaProductCostRuleMap<T extends MetaProductCostRule>(rules: T[], today: string) {
  const todayKey = dateKey(today);
  const currentRules = new Map<string, T>();

  for (const rule of [...rules].sort(compareRulePriority)) {
    const effectiveFrom = dateKey(rule.effectiveFrom);
    const effectiveTo = dateKey(rule.effectiveTo);
    if (effectiveFrom > todayKey || (effectiveTo && effectiveTo < todayKey) || currentRules.has(rule.productId)) {
      continue;
    }
    currentRules.set(rule.productId, rule);
  }

  return currentRules;
}

function compareRulePriority(left: MetaProductCostRule, right: MetaProductCostRule) {
  return (
    dateKey(right.effectiveFrom).localeCompare(dateKey(left.effectiveFrom)) ||
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) ||
    right.id.localeCompare(left.id)
  );
}

function dateKey(value: string | null | undefined) {
  return value?.slice(0, 10) ?? "";
}
