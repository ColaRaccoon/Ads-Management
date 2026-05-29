import { AdsetNameNormalizer } from "./adset-name-normalizer";

export type MatchTypeValue = "CONTAINS" | "EXACT" | "REGEX" | "MANUAL";
export type MatchSourceValue = "RULE" | "MANUAL" | "INFERRED" | "UNMATCHED";
export type AdStageValue = "SC" | "CBO" | "ASC" | "UNKNOWN";

export type ManualProductHistory = {
  productId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type ProductRule = {
  id: string;
  productId: string;
  matchType: MatchTypeValue;
  pattern: string;
  patternKey?: string | null;
  priority: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
};

export type ProductMatchResult = {
  productId: string | null;
  source: MatchSourceValue;
  matchRuleId: string | null;
};

export class AdsetProductMatcher {
  match(
    adsetName: string,
    metricDate: string,
    histories: ManualProductHistory[],
    rules: ProductRule[]
  ): ProductMatchResult {
    const manual = histories.find((history) => isDateInRange(metricDate, history.effectiveFrom, history.effectiveTo));
    if (manual) {
      return { productId: manual.productId, source: "MANUAL", matchRuleId: null };
    }

    const nameKey = AdsetNameNormalizer.toKey(adsetName);
    const activeRules = rules
      .filter((rule) => rule.isActive !== false && isDateInRange(metricDate, rule.validFrom, rule.validTo))
      .sort((a, b) => a.priority - b.priority);

    for (const rule of activeRules) {
      const pattern = rule.patternKey ?? AdsetNameNormalizer.toKey(rule.pattern);
      if (matchesRule(nameKey, rule.matchType, pattern)) {
        return { productId: rule.productId, source: "RULE", matchRuleId: rule.id };
      }
    }

    return { productId: null, source: "UNMATCHED", matchRuleId: null };
  }
}

export type ManualStageHistory = {
  stage: AdStageValue;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type StageMatchResult = {
  stage: AdStageValue;
  source: MatchSourceValue;
};

export class AdsetStageMatcher {
  match(adsetName: string, metricDate: string, histories: ManualStageHistory[]): StageMatchResult {
    const manual = histories.find((history) => isDateInRange(metricDate, history.effectiveFrom, history.effectiveTo));
    if (manual) {
      return { stage: manual.stage, source: "MANUAL" };
    }

    const key = AdsetNameNormalizer.toKey(adsetName);
    if (hasStageToken(key, "asc")) {
      return { stage: "ASC", source: "INFERRED" };
    }
    if (hasStageToken(key, "cbo")) {
      return { stage: "CBO", source: "INFERRED" };
    }
    if (hasStageToken(key, "sc")) {
      return { stage: "SC", source: "INFERRED" };
    }

    return { stage: "UNKNOWN", source: "UNMATCHED" };
  }
}

function hasStageToken(nameKey: string, token: "asc" | "cbo" | "sc"): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(nameKey);
}

function matchesRule(nameKey: string, matchType: MatchTypeValue, pattern: string): boolean {
  if (matchType === "EXACT") {
    return nameKey === pattern;
  }
  if (matchType === "REGEX") {
    return new RegExp(pattern, "i").test(nameKey);
  }
  return nameKey.includes(pattern);
}

export function isDateInRange(date: string, from?: string | null, to?: string | null): boolean {
  if (from && date < from) {
    return false;
  }
  if (to && date > to) {
    return false;
  }
  return true;
}
