export type MetaProductEffectiveRule = {
  id: string;
  productId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  note?: string | null;
};

export type MetaProductCostRule = MetaProductEffectiveRule & {
  salePriceKrw: number | string;
  vatKrw: number | string;
  productCostKrw: number | string;
  shippingKrw: number | string;
  extraCostKrw: number | string;
  fxRateKrwPerUsd?: number | string;
};

export type MetaProductCostRuleDraft = {
  salePriceKrw: string;
  productCostKrw: string;
  shippingKrw: string;
  extraCostKrw: string;
  effectiveFrom: string;
  note: string;
};

export type MetaProductCpaRuleDraft = {
  targetRatio: string;
  watchRatio: string;
  stopRatio: string;
  effectiveFrom: string;
  note: string;
};

export type MetaProductRulePayloadMode = "SNAPSHOT" | "CORRECTION";

export type MetaProductRuleHistoryPreview<T extends MetaProductEffectiveRule> = {
  currentRule: T | null;
  basisRule: T | null;
  sameDateRule: T | null;
  dateCollisionRule: T | null;
  nextRule: T | null;
  expectedEffectiveTo: string | null;
  currentValueImpact: "CURRENT" | "HISTORICAL" | "FUTURE" | "REJECTED_DATE_COLLISION";
};

export const META_PRODUCT_RULE_DEPENDENT_QUERY_KEYS = [
  ["products"],
  ["product-cost-rules"],
  ["product-cpa-rules"],
  ["sales-product-performance"],
  ["daily-report-sales-product-performance"],
  ["ad-creatives"],
  ["daily-report-creatives"],
  ["daily-report-creatives-prev"],
  ["adsets"],
  ["campaigns"],
  ["products-performance"],
  ["dashboard-summary"],
  ["dashboard-trends"],
  ["stage-trends"],
  ["meta-creative-video-trends"]
] as const;

export function currentMetaProductCostRuleMap<T extends MetaProductCostRule>(rules: T[], today: string) {
  return currentMetaProductRuleMap(rules, today);
}

export function currentMetaProductRuleMap<T extends MetaProductEffectiveRule>(rules: T[], today: string) {
  const todayKey = dateKey(today);
  const currentRules = new Map<string, T>();

  for (const rule of [...rules].sort(compareMetaProductRulePriority)) {
    const effectiveFrom = dateKey(rule.effectiveFrom);
    const effectiveTo = dateKey(rule.effectiveTo);
    if (effectiveFrom > todayKey || (effectiveTo && effectiveTo < todayKey) || currentRules.has(rule.productId)) {
      continue;
    }
    currentRules.set(rule.productId, rule);
  }

  return currentRules;
}

export function metaProductRuleHistory<T extends MetaProductEffectiveRule>(rules: readonly T[], productId: string) {
  return rules.filter((rule) => rule.productId === productId).sort(compareMetaProductRulePriority);
}

export function previewMetaProductRuleHistory<T extends MetaProductEffectiveRule>(
  rules: readonly T[],
  targetDate: string,
  today: string,
  correctingRuleId?: string | null
): MetaProductRuleHistoryPreview<T> {
  const datedRules = rules.filter((rule) => Boolean(validDateKey(rule.effectiveFrom)));
  const currentRule = ruleForDate(datedRules, today);
  const selectedRule = correctingRuleId
    ? datedRules.find((rule) => rule.id === correctingRuleId) ?? null
    : null;
  const candidates = selectedRule ? datedRules.filter((rule) => rule.id !== selectedRule.id) : datedRules;
  const sameDateRule = candidates
    .filter((rule) => dateKey(rule.effectiveFrom) === targetDate)
    .sort(compareMetaProductRulePriority)[0] ?? null;
  const dateCollisionRule = selectedRule ? sameDateRule : null;
  const basisRule = selectedRule ?? sameDateRule ?? candidates
    .filter((rule) => dateKey(rule.effectiveFrom) <= targetDate)
    .sort(compareMetaProductRulePriority)[0] ?? null;
  const nextRule = candidates
    .filter((rule) => dateKey(rule.effectiveFrom) > targetDate)
    .sort(compareMetaProductRuleChronology)[0] ?? null;
  const expectedEffectiveTo = nextRule ? previousDateInput(dateKey(nextRule.effectiveFrom)) : null;
  const previewId = selectedRule?.id ?? sameDateRule?.id ?? "__meta-product-rule-preview__";
  const previewRule = {
    ...(basisRule ?? {}),
    id: previewId,
    productId: basisRule?.productId ?? datedRules[0]?.productId ?? "",
    effectiveFrom: targetDate,
    effectiveTo: expectedEffectiveTo,
    createdAt: selectedRule?.createdAt ?? sameDateRule?.createdAt ?? "9999-12-31T23:59:59.999Z"
  } as T;
  const normalizedCandidates = normalizeMetaProductRuleRanges([
    ...candidates.filter((rule) => rule.id !== sameDateRule?.id),
    previewRule
  ]);
  const currentAfterSave = ruleForDate(normalizedCandidates, today);
  const changesCurrentRule =
    currentRule?.id === previewId ||
    currentAfterSave?.id === previewId ||
    currentRule?.id !== currentAfterSave?.id;
  const currentValueImpact = dateCollisionRule
    ? "REJECTED_DATE_COLLISION"
    : changesCurrentRule
      ? "CURRENT"
      : targetDate > today
        ? "FUTURE"
        : "HISTORICAL";

  return {
    currentRule,
    basisRule,
    sameDateRule,
    dateCollisionRule,
    nextRule,
    expectedEffectiveTo,
    currentValueImpact
  };
}

export function metaProductCostRulePayload(
  draft: MetaProductCostRuleDraft,
  basis: MetaProductCostRuleDraft | null,
  mode: MetaProductRulePayloadMode
) {
  return changedRulePayload(
    draft,
    basis,
    mode,
    ["salePriceKrw", "productCostKrw", "shippingKrw", "extraCostKrw"] as const
  );
}

export function metaProductCpaRulePayload(
  draft: MetaProductCpaRuleDraft,
  basis: MetaProductCpaRuleDraft | null,
  mode: MetaProductRulePayloadMode
) {
  return changedRulePayload(
    draft,
    basis,
    mode,
    ["targetRatio", "watchRatio", "stopRatio"] as const
  );
}

export function metaProductCostSnapshotPath(productId: string) {
  return `/products/${encodeURIComponent(productId)}/cost-rule-snapshots`;
}

export function metaProductCostCorrectionPath(productId: string, ruleId: string) {
  return `/products/${encodeURIComponent(productId)}/cost-rules/${encodeURIComponent(ruleId)}/correction`;
}

export function metaProductCpaSnapshotPath(productId: string) {
  return `/products/${encodeURIComponent(productId)}/cpa-rule-snapshots`;
}

export function metaProductCpaCorrectionPath(productId: string, ruleId: string) {
  return `/products/${encodeURIComponent(productId)}/cpa-rules/${encodeURIComponent(ruleId)}/correction`;
}

export function compareMetaProductRulePriority(left: MetaProductEffectiveRule, right: MetaProductEffectiveRule) {
  return (
    dateKey(right.effectiveFrom).localeCompare(dateKey(left.effectiveFrom)) ||
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) ||
    right.id.localeCompare(left.id)
  );
}

function compareMetaProductRuleChronology(left: MetaProductEffectiveRule, right: MetaProductEffectiveRule) {
  return (
    dateKey(left.effectiveFrom).localeCompare(dateKey(right.effectiveFrom)) ||
    String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeMetaProductRuleRanges<T extends MetaProductEffectiveRule>(rules: readonly T[]): T[] {
  const chronological = [...rules].sort(compareMetaProductRuleChronology);
  return chronological.map((rule, index) => ({
    ...rule,
    effectiveTo: chronological[index + 1]
      ? previousDateInput(dateKey(chronological[index + 1].effectiveFrom))
      : null
  }));
}

function changedRulePayload<
  T extends { effectiveFrom: string; note: string },
  K extends Exclude<keyof T, "effectiveFrom" | "note">
>(draft: T, basis: T | null, mode: MetaProductRulePayloadMode, valueFields: readonly K[]) {
  const payload: Record<string, string | null> = {};
  const effectiveFrom = dateKey(draft.effectiveFrom);
  const basisEffectiveFrom = dateKey(basis?.effectiveFrom);
  if (mode === "SNAPSHOT" || effectiveFrom !== basisEffectiveFrom) {
    payload.effectiveFrom = effectiveFrom;
  }

  for (const field of valueFields) {
    if (!basis || draft[field] !== basis[field]) {
      payload[String(field)] = String(draft[field]);
    }
  }

  const note = draft.note.trim() || null;
  const basisNote = basis?.note.trim() || null;
  if (note !== basisNote) {
    payload.note = note;
  }

  return payload;
}

function ruleForDate<T extends MetaProductEffectiveRule>(rules: readonly T[], date: string): T | null {
  return rules
    .filter((rule) => {
      const effectiveFrom = validDateKey(rule.effectiveFrom);
      const effectiveTo = validDateKey(rule.effectiveTo);
      return Boolean(effectiveFrom && effectiveFrom <= date && (!effectiveTo || effectiveTo >= date));
    })
    .sort(compareMetaProductRulePriority)[0] ?? null;
}

function previousDateInput(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validDateKey(value: string | null | undefined) {
  const candidate = dateKey(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function dateKey(value: string | null | undefined) {
  return value?.slice(0, 10) ?? "";
}
