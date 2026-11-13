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
  adEnabled?: boolean;
};

export type CoupangMatchReason = "MATCHED" | "NO_MATCH" | "AMBIGUOUS_MATCH" | "EXCLUDED_BY_KEYWORD" | "OPTION_CONFLICT" | "AD_DISABLED";
export type CoupangProductText = { productName: string; optionName?: string | null };

export type CoupangMatchResult = {
  productId: string | null;
  source: "RULE" | "UNMATCHED";
  matchRuleId: string | null;
  reason: CoupangMatchReason;
  candidates: string[];
  candidateProductIds: string[];
  reviewReasons: string[];
};

type MatchCandidate = {
  rule: CoupangRuleInput;
  includeCount: number;
  includeLength: number;
};

export class CoupangProductMatcher {
  matchAdProducts(input: { adExecutionProductName: string; adName?: string | null; conversionProductName: string }, rules: CoupangRuleInput[], date?: string | Date | null) {
    const spendText = !isPlaceholderCoupangText(input.adExecutionProductName) ? input.adExecutionProductName : input.adName ?? "";
    const spend = this.matchProduct({ productName: isPlaceholderCoupangText(spendText) ? "" : spendText }, rules, date, true);
    const conversionMissing = isPlaceholderCoupangText(input.conversionProductName);
    // Generic video rows are campaign summaries. A verified spend alias does
    // not establish which product generated their (possibly indirect) revenue.
    const genericVideo = /^\[video\]내동영상\d+$/.test(normalizeCoupangText(spendText));
    const inferred = conversionMissing && spend.reason === "MATCHED" && !genericVideo;
    const conversion = inferred ? spend : this.matchText(conversionMissing ? "" : input.conversionProductName, rules, date);
    return { spend, conversion, inferred, conversionMissing, spendText };
  }

  matchText(text: string, rules: CoupangRuleInput[], date?: string | Date | null): CoupangMatchResult {
    return this.matchProduct({ productName: text }, rules, date);
  }

  matchProduct(input: CoupangProductText, rules: CoupangRuleInput[], date?: string | Date | null, adSpend = false): CoupangMatchResult {
    const prepared = prepareCoupangText(input);
    const activeRules = rules
      .filter((rule) => rule.isActive !== false)
      .filter((rule) => isRuleEffective(rule, date));

    const candidates: MatchCandidate[] = [];
    const excluded: string[] = [];
    const disabled: string[] = [];
    const conflicts: string[] = [];
    for (const rule of activeRules) {
      const match = evaluatePreparedRule(prepared, rule);
      if (adSpend && rule.adEnabled === false) {
        if (match.matched) disabled.push(ruleLabel(rule));
        continue;
      }
      if (match.excluded) {
        excluded.push(`${ruleLabel(rule)}: ${match.excludedKeywords.join(", ")}`);
      }
      if (match.quantityConflict) conflicts.push(ruleLabel(rule));
      if (match.matched) {
        candidates.push({
          rule,
          includeCount: match.includeKeywords.length,
          includeLength: match.includeKeywords.reduce((total, keyword) => total + keyword.length, 0)
        });
      }
    }

    // A broad rule without a quantity must not hide contradictory unit evidence.
    if (conflicts.length) return unmatched("OPTION_CONFLICT", conflicts);
    if (candidates.length === 0) {
      if (excluded.length) return unmatched("EXCLUDED_BY_KEYWORD", excluded);
      if (disabled.length) return unmatched("AD_DISABLED", disabled);
      return unmatched("NO_MATCH", []);
    }

    const ordered = candidates.sort(
      (a, b) =>
        a.rule.priority - b.rule.priority ||
        b.includeCount - a.includeCount ||
        b.includeLength - a.includeLength ||
        ruleLabel(a.rule).localeCompare(ruleLabel(b.rule)) || a.rule.id.localeCompare(b.rule.id)
    );
    const best = ordered[0];
    const tied = ordered.filter(
      (candidate) =>
        candidate.rule.priority === best.rule.priority &&
        candidate.includeCount === best.includeCount &&
        candidate.includeLength === best.includeLength
    );

    const candidateProductIds = [...new Set(ordered.map(candidate => candidate.rule.productId))];
    if (new Set(tied.map(candidate => candidate.rule.productId)).size > 1) {
      return { ...unmatched("AMBIGUOUS_MATCH", tied.map((candidate) => ruleLabel(candidate.rule))), candidateProductIds };
    }

    return {
      productId: best.rule.productId,
      source: "RULE",
      matchRuleId: best.rule.id,
      reason: "MATCHED",
      candidates: ordered.map(candidate => ruleLabel(candidate.rule)),
      candidateProductIds,
      reviewReasons: [...(candidateProductIds.length > 1 ? ["LOWER_PRIORITY_PRODUCT_CANDIDATE"] : []),
        ...(disabled.length ? ["DISABLED_MATCHING_RULE"] : [])]
    };
  }
}

export function normalizeCoupangText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .split(/\s+/)
    .join("")
    .toLowerCase();
}

/** Numeric boundaries prevent 1개 matching 11개, and 2 matching 20/1.2.
 * Punctuation and bundle notation are retained; 1+1 is never silently converted to 2. */
export function containsCoupangKeyword(target: string, keyword: string): boolean {
  let start = target.indexOf(keyword);
  while (start >= 0) {
    const before = target[start - 1] ?? "", after = target[start + keyword.length] ?? "";
    const decimalBefore = before === "." && /\d/.test(target[start - 2] ?? "");
    const decimalAfter = after === "." && /\d/.test(target[start + keyword.length + 1] ?? "");
    if ((!/^\d/.test(keyword) || (!/[\d+]/.test(before) && !decimalBefore)) &&
        (!/\d$/.test(keyword) || (!/\d/.test(after) && !decimalAfter))) return true;
    start = target.indexOf(keyword, start + 1);
  }
  return false;
}

export function evaluateCoupangRule(input: CoupangProductText, rule: Pick<CoupangRuleInput, "includeKeywords" | "excludeKeywords">) {
  return evaluatePreparedRule(prepareCoupangText(input), rule);
}

function prepareCoupangText(input: CoupangProductText) {
  const name = normalizeCoupangText(input.productName), option = normalizeCoupangText(input.optionName);
  const fields = [name, option];
  // Sales options can repeat the entire marketing title. Ad reports combine
  // the title and selected option using commas. Quantities in the title are
  // not the selected pack size (e.g. "깔창 1세트, L2세트").
  const selectedOption = option ? stripRepeatedTitle(option, name) : combinedOption(name);
  const quantityText = selectedOption && hasOptionQuantity(selectedOption) ? selectedOption : name;
  // An explicitly collected option is authoritative for a sale-unit condition.
  // For ad/promotion reports there is only combined text; keep it intact.
  // A report can express one retail set as title "1세트", option "1개".
  // Preserve that explicit title evidence only for a single item; never let it
  // override an option containing two sets/items or a bundle expression.
  const singleSetTitle = selectedOption && containsCoupangKeyword(name, "1세트") &&
    containsCoupangKeyword(selectedOption, "1개") &&
    !/[+\/]/.test(selectedOption) && !/\d+(?:개(?:입)?|세트)?\+\d/.test(name) &&
    [...selectedOption.matchAll(/(\d+(?:\.\d+)?)(개(?:입)?|매|팩|세트|쌍|kg|g|ml|l)/g)].every(match => match[1] === "1");
  const quantities = new Map<string, Set<string>>();
  for (const match of quantityText.matchAll(/(?<![\d.+])(\d+)(개(?:입)?|매|팩|세트|쌍|kg|g|ml|l)/g)) {
    const unit = match[2].replace(/개입$/, "개");
    const values = quantities.get(unit) ?? new Set<string>(); values.add(match[1]); quantities.set(unit, values);
  }
  for (const match of quantityText.matchAll(/(\d+(?:\/\d+)+)(개(?:입)?|매|팩|세트|쌍)/g)) {
    const unit = match[2].replace(/개입$/, "개");
    const values = quantities.get(unit) ?? new Set<string>();
    for (const value of match[1].split("/")) values.add(value);
    quantities.set(unit, values);
  }
  return { name, fields, quantityText, singleSetTitle, quantities,
    bundleConflict: /\d+(?:개(?:입)?|매|팩|세트|쌍)\+\d/.test(quantityText) };
}

function evaluatePreparedRule(prepared: ReturnType<typeof prepareCoupangText>, rule: Pick<CoupangRuleInput, "includeKeywords" | "excludeKeywords">) {
  const { name, fields, quantityText, singleSetTitle, quantities, bundleConflict } = prepared;
  const { includeKeywords, excludeKeywords } = normalizedRuleKeywords(rule);
  const has = (keyword: string) => (quantityKeyword(keyword) ?
    (keyword === "1세트" && singleSetTitle ? [quantityText, name] : [quantityText]) : fields)
    .some(field => containsCoupangKeyword(field, keyword));
  const includes = includeKeywords.length > 0 && includeKeywords.every(has);
  const excludedKeywords = excludeKeywords.filter(keyword => fields.some(field => containsCoupangKeyword(field, keyword)));
  const excluded = includes && excludedKeywords.length > 0;
  const quantityConflict = includes && !excluded && includeKeywords.some(keyword => {
    if (!quantityKeyword(keyword)) return false;
    const unit = keyword.replace(/^\d+/, "").replace(/개입$/, "개");
    return (quantities.get(unit)?.size ?? 0) > 1 || bundleConflict;
  });
  const matched = includes && !excluded && !quantityConflict;
  return { excluded, excludedKeywords, quantityConflict, matched, includeKeywords };
}

const quantityKeyword = (value: string) => /^\d+(?:개(?:입)?|매|팩|세트|쌍|kg|g|ml|l)$/.test(value);
type KeywordRule = Pick<CoupangRuleInput, "includeKeywords" | "excludeKeywords">;
const keywordCache = new WeakMap<KeywordRule, { rawInclude: string[]; rawExclude: string[]; includeKeywords: string[]; excludeKeywords: string[] }>();
function normalizedRuleKeywords(rule: KeywordRule) {
  const cached = keywordCache.get(rule);
  const same = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  if (cached && same(cached.rawInclude, rule.includeKeywords) && same(cached.rawExclude, rule.excludeKeywords)) return cached;
  const value = { rawInclude: [...rule.includeKeywords], rawExclude: [...rule.excludeKeywords],
    includeKeywords: uniqueNormalized(rule.includeKeywords), excludeKeywords: uniqueNormalized(rule.excludeKeywords) };
  keywordCache.set(rule, value); return value;
}

function stripRepeatedTitle(option: string, name: string) {
  if (name && option.startsWith(`${name},`)) {
    const selected = option.slice(name.length + 1);
    // A size-only suffix ("L") does not negate an explicit title unit ("1세트").
    if (hasOptionQuantity(selected)) return selected;
  }
  return option;
}

function combinedOption(name: string): string | null {
  const comma = name.indexOf(",");
  if (comma < 0) return null;
  const title = name.slice(0, comma);
  // A bare quantity list has no product title and remains contradictory.
  if (!title.replace(/\d+(?:개(?:입)?|매|팩|세트|쌍|kg|g|ml|l)/g, "").match(/[가-힣a-z]/)) return null;
  const selected = name.slice(comma + 1);
  return hasOptionQuantity(selected) ? selected : null;
}

function hasOptionQuantity(value: string) {
  return /\d+(?:개(?:입)?|매|팩|세트|쌍|kg|g|ml|l)/.test(value);
}

export function isPlaceholderCoupangText(value: string | null | undefined) {
  return !value?.trim() || value.trim() === "-";
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
    candidates,
    candidateProductIds: [],
    reviewReasons: reason === "OPTION_CONFLICT" ? ["CONFLICTING_OPTION_QUANTITIES"] : []
  };
}
