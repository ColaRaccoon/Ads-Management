export type ComparisonValue = {
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
};

export class ComparisonCalculator {
  compare(current: number | null, previous: number | null): ComparisonValue {
    if (current === null || previous === null) {
      return { current, previous, delta: null, deltaPct: null };
    }
    const delta = current - previous;
    return {
      current,
      previous,
      delta,
      deltaPct: previous === 0 ? null : (delta / previous) * 100
    };
  }
}
