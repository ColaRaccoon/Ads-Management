export type CoupangCostHistoryRule = {
  id: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  createdAt?: string | null;
};

export type CoupangCostHistoryPreview = {
  currentRule: CoupangCostHistoryRule | null;
  basisRule: CoupangCostHistoryRule | null;
  sameDateRule: CoupangCostHistoryRule | null;
  dateCollisionRule: CoupangCostHistoryRule | null;
  nextRule: CoupangCostHistoryRule | null;
  expectedEffectiveTo: string | null;
  currentValueImpact: "CURRENT" | "HISTORICAL" | "FUTURE" | "REJECTED_DATE_COLLISION";
};

export function koreaTodayDateInput(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function previewCoupangCostHistory(
  rules: CoupangCostHistoryRule[],
  targetDate: string,
  today: string,
  correctingRuleId?: string | null
): CoupangCostHistoryPreview {
  const datedRules = rules
    .filter((rule): rule is CoupangCostHistoryRule & { effectiveFrom: string } => Boolean(dateOnly(rule.effectiveFrom)))
    .map((rule) => ({ ...rule, effectiveFrom: dateOnly(rule.effectiveFrom)! }));
  const currentRule = ruleForDate(datedRules, today);
  const selectedRule = correctingRuleId
    ? datedRules.find((rule) => rule.id === correctingRuleId) ?? null
    : null;
  const candidates = selectedRule ? datedRules.filter((rule) => rule.id !== selectedRule.id) : datedRules;
  const sameDateRule = candidates
    .filter((rule) => rule.effectiveFrom === targetDate)
    .sort(compareRuleDescending)[0] ?? null;
  const dateCollisionRule = selectedRule ? sameDateRule : null;
  const basisRule = selectedRule ?? sameDateRule ?? candidates
    .filter((rule) => rule.effectiveFrom <= targetDate)
    .sort(compareRuleDescending)[0] ?? null;
  const nextRule = candidates
    .filter((rule) => rule.effectiveFrom > targetDate)
    .sort(compareRuleAscending)[0] ?? null;
  const expectedEffectiveTo = nextRule ? previousDateInput(nextRule.effectiveFrom) : null;
  const previewId = selectedRule?.id ?? sameDateRule?.id ?? "__cost-rule-preview__";
  const previewRules = [
    ...candidates.filter((rule) => rule.id !== sameDateRule?.id),
    { id: previewId, effectiveFrom: targetDate, effectiveTo: expectedEffectiveTo, createdAt: "9999-12-31" }
  ];
  const currentAfterSave = ruleForDate(previewRules, today);
  const currentValueImpact = dateCollisionRule
    ? "REJECTED_DATE_COLLISION"
    : targetDate > today
      ? "FUTURE"
      : currentAfterSave?.id === previewId
        ? "CURRENT"
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

function ruleForDate<T extends CoupangCostHistoryRule>(rules: T[], date: string): T | null {
  return rules
    .filter((rule) => {
      const from = dateOnly(rule.effectiveFrom);
      const to = dateOnly(rule.effectiveTo);
      return Boolean(from && from <= date && (!to || to >= date));
    })
    .sort(compareRuleDescending)[0] ?? null;
}

function compareRuleDescending(left: CoupangCostHistoryRule, right: CoupangCostHistoryRule) {
  return String(right.effectiveFrom).localeCompare(String(left.effectiveFrom))
    || String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
    || right.id.localeCompare(left.id);
}

function compareRuleAscending(left: CoupangCostHistoryRule, right: CoupangCostHistoryRule) {
  return String(left.effectiveFrom).localeCompare(String(right.effectiveFrom))
    || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))
    || left.id.localeCompare(right.id);
}

function previousDateInput(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function dateOnly(value: string | null | undefined) {
  const candidate = value?.slice(0, 10) ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}
