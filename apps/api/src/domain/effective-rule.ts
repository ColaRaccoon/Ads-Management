export type EffectiveRulePeriod = {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
};

export function compareEffectiveRulePriority(left: EffectiveRulePeriod, right: EffectiveRulePeriod) {
  return (
    right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  );
}

export function findEffectiveRuleForDate<T extends EffectiveRulePeriod>(rules: readonly T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort(compareEffectiveRulePriority)[0] ?? null
  );
}

export function previousUtcDate(date: Date) {
  const previous = new Date(date);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous;
}

export function dateValuesDiffer(left: Date | null, right: Date | null) {
  return left?.getTime() !== right?.getTime();
}
