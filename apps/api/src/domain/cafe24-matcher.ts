import { formatDateOnly } from "./date-number";
import { ParsedCafe24OrderRow } from "./cafe24-csv";

export type Cafe24RuleInput = {
  id: string;
  productId: string;
  displayName?: string | null;
  productNumbers: string[];
  productNameAliases: string[];
  optionIncludeKeywords: string[];
  optionExcludeKeywords: string[];
  priority: number;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  isActive?: boolean;
  adCostSourceProductId?: string | null;
  roasGroup?: string | null;
};

export type Cafe24MatchResult = {
  productId: string | null;
  source: "RULE" | "UNMATCHED";
  matchRuleId: string | null;
  reason: "MATCHED" | "NO_MATCH" | "AMBIGUOUS_MATCH";
  candidates: string[];
};

export class Cafe24ProductMatcher {
  match(row: Pick<ParsedCafe24OrderRow, "productNo" | "productName" | "optionName" | "orderDate">, rules: Cafe24RuleInput[]): Cafe24MatchResult {
    const orderedRules = rules
      .filter((rule) => rule.isActive !== false)
      .filter((rule) => isRuleEffective(rule, row.orderDate))
      .sort((a, b) => a.priority - b.priority || ruleLabel(a).localeCompare(ruleLabel(b)));

    const matches = orderedRules.filter((rule) => matchesRule(row, rule));
    if (matches.length === 0) {
      return unmatched("NO_MATCH", []);
    }
    if (matches.length > 1) {
      return unmatched("AMBIGUOUS_MATCH", matches.map(ruleLabel));
    }

    const match = matches[0];
    return {
      productId: match.productId,
      source: "RULE",
      matchRuleId: match.id,
      reason: "MATCHED",
      candidates: [ruleLabel(match)]
    };
  }
}

export function matchesRule(
  row: Pick<ParsedCafe24OrderRow, "productNo" | "productName" | "optionName" | "orderDate">,
  rule: Cafe24RuleInput
) {
  const productNo = normalizeProductNo(row.productNo);
  const productName = normalizeCafe24Text(row.productName);
  const optionName = normalizeCafe24Text(row.optionName);

  const productNumbers = uniqueNormalized(rule.productNumbers, normalizeProductNo);
  if (productNumbers.length > 0 && !productNumbers.includes(productNo)) {
    return false;
  }

  const aliases = uniqueNormalized(rule.productNameAliases, normalizeCafe24Text);
  if (aliases.length > 0 && aliases.every((alias) => !productName.includes(alias) && !optionName.includes(alias))) {
    return false;
  }

  const includeKeywords = uniqueNormalized(rule.optionIncludeKeywords, normalizeCafe24Text);
  if (includeKeywords.length > 0 && includeKeywords.some((keyword) => !optionName.includes(keyword))) {
    return false;
  }

  const excludeKeywords = uniqueNormalized(rule.optionExcludeKeywords, normalizeCafe24Text);
  if (excludeKeywords.some((keyword) => optionName.includes(keyword))) {
    return false;
  }

  return true;
}

export function normalizeCafe24Text(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\s+/)
    .join("")
    .toLowerCase();
}

export function normalizeProductNo(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function isRuleEffective(rule: Cafe24RuleInput, orderDate: Date | null) {
  if (!orderDate) {
    return true;
  }
  const dateKey = formatDateOnly(orderDate);
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

function uniqueNormalized(values: string[], normalize: (value: string) => string) {
  return Array.from(new Set(values.map((value) => normalize(value)).filter(Boolean)));
}

function ruleLabel(rule: Cafe24RuleInput) {
  return rule.displayName?.trim() || rule.id;
}

function unmatched(reason: Cafe24MatchResult["reason"], candidates: string[]): Cafe24MatchResult {
  return {
    productId: null,
    source: "UNMATCHED",
    matchRuleId: null,
    reason,
    candidates
  };
}
