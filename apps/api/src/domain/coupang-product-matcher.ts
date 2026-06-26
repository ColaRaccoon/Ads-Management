import { formatDateOnly } from "./date-number";

export type CoupangRuleInput = {
  id: string;
  productId: string;
  displayName?: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  priority: number;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  isActive?: boolean;
};

export type CoupangMatchReason = "MATCHED" | "NO_MATCH" | "AMBIGUOUS_MATCH" | "EXCLUDED_BY_KEYWORD";

export type CoupangMatchResult = {
  productId: string | null;
  source: "RULE" | "UNMATCHED";
  matchRuleId: string | null;
  reason: CoupangMatchReason;
  candidates: string[];
};

type MatchCandidate = {
  rule: CoupangRuleInput;
  includeCount: number;
  includeLength: number;
};

export class CoupangProductMatcher {
  matchText(text: string, rules: CoupangRuleInput[], date?: string | Date | null): CoupangMatchResult {
    const target = normalizeCoupangText(text);
    const activeRules = rules
      .filter((rule) => rule.isActive !== false)
      .filter((rule) => isRuleEffective(rule, date));

    const candidates: MatchCandidate[] = [];
    let excludedCount = 0;
    for (const rule of activeRules) {
      const match = matchRule(target, rule);
      if (match.excluded) {
        excludedCount += 1;
      }
      if (match.matched) {
        candidates.push({
          rule,
          includeCount: match.includeKeywords.length,
          includeLength: match.includeKeywords.reduce((total, keyword) => total + keyword.length, 0)
        });
      }
    }

    if (candidates.length === 0) {
      return unmatched(excludedCount > 0 ? "EXCLUDED_BY_KEYWORD" : "NO_MATCH", []);
    }

    const ordered = candidates.sort(
      (a, b) =>
        a.rule.priority - b.rule.priority ||
        b.includeCount - a.includeCount ||
        b.includeLength - a.includeLength ||
        ruleLabel(a.rule).localeCompare(ruleLabel(b.rule))
    );
    const best = ordered[0];
    const tied = ordered.filter(
      (candidate) =>
        candidate.rule.priority === best.rule.priority &&
        candidate.includeCount === best.includeCount &&
        candidate.includeLength === best.includeLength
    );

    if (tied.length > 1) {
      return unmatched("AMBIGUOUS_MATCH", tied.map((candidate) => ruleLabel(candidate.rule)));
    }

    return {
      productId: best.rule.productId,
      source: "RULE",
      matchRuleId: best.rule.id,
      reason: "MATCHED",
      candidates: [ruleLabel(best.rule)]
    };
  }
}

export function normalizeCoupangText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .split(/\s+/)
    .join("")
    .toLowerCase();
}

function matchRule(normalizedTarget: string, rule: CoupangRuleInput) {
  const includeKeywords = uniqueNormalized(rule.includeKeywords);
  const excludeKeywords = uniqueNormalized(rule.excludeKeywords);
  const excluded = excludeKeywords.some((keyword) => normalizedTarget.includes(keyword));
  const matched = !excluded && includeKeywords.length > 0 && includeKeywords.every((keyword) => normalizedTarget.includes(keyword));
  return { excluded, matched, includeKeywords };
}

function isRuleEffective(rule: CoupangRuleInput, date?: string | Date | null) {
  if (!date) {
    return true;
  }
  const dateKey = date instanceof Date ? formatDateOnly(date) : date.slice(0, 10);
  const validFrom = dateKeyOrNull(rule.validFrom);
  const validTo = dateKeyOrNull(rule.validTo);
  return (!validFrom || validFrom <= dateKey) && (!validTo || validTo >= dateKey);
}

function dateKeyOrNull(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? formatDateOnly(value) : value.slice(0, 10);
}

function uniqueNormalized(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeCoupangText(value)).filter(Boolean)));
}

function ruleLabel(rule: CoupangRuleInput) {
  return rule.displayName?.trim() || rule.id;
}

function unmatched(reason: CoupangMatchReason, candidates: string[]): CoupangMatchResult {
  return {
    productId: null,
    source: "UNMATCHED",
    matchRuleId: null,
    reason,
    candidates
  };
}
