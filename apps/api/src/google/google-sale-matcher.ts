import { Cafe24ProductMatcher, type Cafe24RuleInput } from "../domain/cafe24-matcher";

type Sale = Parameters<Cafe24ProductMatcher["match"]>[0];
type Product = { id: string; name: string; displayName: string };

const isYoutubeMarker = (value: string) => ["유튜브", "[유튜브]"].includes(value.replace(/\s+/g, ""));

/** Reuse dated Cafe24 option rules. YouTube pages ignore numbers and channel exclusions.
 * Require a textual product identity so a number-only rule cannot match every sale. */
export function createGoogleSaleMatcher(rules: readonly Cafe24RuleInput[], products: readonly Product[]) {
  const names = new Map(products.map(product => [product.id, [product.name, product.displayName].filter(Boolean)]));
  const youtubeRules = rules.filter(rule => names.has(rule.productId)).map(rule => ({
    ...rule,
    productNumbers: [],
    productNameExcludeKeywords: rule.productNameExcludeKeywords?.filter(value => !isYoutubeMarker(value)),
    optionExcludeKeywords: rule.optionExcludeKeywords.filter(value => !isYoutubeMarker(value)),
    productNameAliases: rule.productNameAliases.some(value => value.trim()) ||
      rule.productNameIncludeKeywords?.some(value => value.trim())
      ? rule.productNameAliases : names.get(rule.productId)!
  }));
  const matcher = new Cafe24ProductMatcher();
  return (line: Sale) => matcher.match(line, line.productName?.includes("[유튜브]") ? youtubeRules : [...rules]);
}
