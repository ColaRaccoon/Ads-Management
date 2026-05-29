export type PeriodQuery = {
  from: string;
  to: string;
};

export type DashboardSummary = {
  selectedPeriod: {
    from: string;
    to: string;
    selectedDays: number;
    dataDays: number;
  };
  totals: Record<string, number | null>;
  averages: Record<string, number | null>;
  comparisons: Record<string, unknown>;
  health: {
    unmatchedCount: number;
    missingCostRuleCount: number;
    missingCpaRuleCount: number;
    missingExchangeRateCount: number;
  };
  decisions: {
    counts: Record<string, number>;
    topRecommendations: Array<Record<string, any>>;
  };
};

export type TrendResponse = {
  daily: Array<Record<string, any>>;
  products: Array<Record<string, any>>;
  stages: Array<Record<string, any>>;
};

export type Product = {
  id: string;
  code: string;
  name: string;
  displayName: string;
};
