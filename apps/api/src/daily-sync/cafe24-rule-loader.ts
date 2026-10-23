import type { Cafe24ProductRule, Prisma, PrismaClient } from "@prisma/client";
import type { Cafe24RuleInput } from "../domain/cafe24-matcher";
import { formatDateOnly } from "../domain/date-number";

/** The same active Cafe24 product rules used by CSV import and rematch. */
export async function loadCafe24MatcherRules(
  client: PrismaClient | Prisma.TransactionClient
): Promise<Cafe24RuleInput[]> {
  const rules = await client.cafe24ProductRule.findMany({
    where: { isActive: true, product: { is: { isActive: true } } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });
  return toCafe24MatcherRules(rules);
}

export type Cafe24MatcherRuleRow = Pick<Cafe24ProductRule,
  "id" | "productId" | "displayName" | "productNumbers" | "productNameAliases" |
  "optionIncludeKeywords" | "optionExcludeKeywords" | "priority" |
  "validFrom" | "validTo" | "isActive" | "adCostSourceProductId" | "roasGroup">;

/** Pure projection for already selected, ordered rules; it never changes DB state. */
export function toCafe24MatcherRules(rows: readonly Cafe24MatcherRuleRow[]): Cafe24RuleInput[] {
  return rows.map((rule) => ({
    id: rule.id,
    productId: rule.productId,
    displayName: rule.displayName,
    productNumbers: jsonStringArray(rule.productNumbers),
    productNameAliases: jsonStringArray(rule.productNameAliases),
    optionIncludeKeywords: jsonStringArray(rule.optionIncludeKeywords),
    optionExcludeKeywords: jsonStringArray(rule.optionExcludeKeywords),
    priority: rule.priority,
    validFrom: formatDateOnly(rule.validFrom),
    validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
    isActive: rule.isActive,
    adCostSourceProductId: rule.adCostSourceProductId,
    roasGroup: rule.roasGroup
  }));
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
}
