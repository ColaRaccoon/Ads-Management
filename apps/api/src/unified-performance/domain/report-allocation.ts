import type { UnifiedRule } from "@prisma/client";
import type { AdapterBatch, AdapterRequest, Quality } from "../types";
import { ExactDecimal as D, money, quantizeMoney } from "./decimal";
import { normalizeProductName } from "./product-name-resolver";

export interface AllocatedAmount { productName: string | null; amount: string | null; attribution: "DIRECT" | "ALLOCATED" | "UNALLOCATED"; quality: Quality }
export interface AllocationInput {
  component: "AD_SPEND" | "SHIPPING_INCOME" | "SHIPPING_COST" | "FAKE_PURCHASE" | "OTHER";
  name: string;
  productName: string | null;
  amount: string | null;
  attribution: "DIRECT" | "ALLOCATED" | "UNALLOCATED";
  quality: Quality;
}
const uniq = (values: readonly string[]) => [...new Set(values)].sort();

/** Exact proportional shares are rounded once at the destination money scale. */
export function allocateProportionally(amount: string, targets: readonly { productName: string; weight: string }[]) {
  const input = money(amount), total = targets.reduce((sum, row) => sum.plus(money(row.weight)), new D(0));
  if (targets.some(row => money(row.weight).isNegative()) || new Set(targets.map(row => row.productName)).size !== targets.length)
    throw new Error("INVALID_ALLOCATION_TARGETS");
  if (!targets.length || total.isZero()) return [];
  const quantum = new D("0.000001");
  const rows = targets.map(row => {
    const exact = input.abs().mul(row.weight).div(total), base = exact.toDecimalPlaces(6, D.ROUND_DOWN);
    return { productName: row.productName, base, remainder: exact.minus(base) };
  }).sort((a, b) => b.remainder.cmp(a.remainder) || (a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0));
  let remaining = input.abs().minus(rows.reduce((sum, row) => sum.plus(row.base), new D(0)));
  for (const row of rows) if (remaining.gte(quantum)) { row.base = row.base.plus(quantum); remaining = remaining.minus(quantum); }
  if (!remaining.isZero()) throw new Error("UNRESOLVED_ALLOCATION_RESIDUAL");
  return rows.sort((a, b) => a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0)
    .map(row => ({ productName: row.productName, amount: quantizeMoney(input.isNegative() ? row.base.negated() : row.base) }));
}

/** Allocation belongs to the source partition, before the user's selection is applied. */
export function allocateReportAmount(request: AdapterRequest, batch: AdapterBatch, rules: readonly UnifiedRule[], input: AllocationInput): AllocatedAmount[] {
  const initial: AllocatedAmount = { productName: input.productName, amount: input.amount, attribution: input.productName ? input.attribution : "UNALLOCATED", quality: input.quality };
  if (input.productName !== null || input.amount === null) return [initial];
  const date = request.from, platform = batch.coverage[0]?.platform ?? batch.sales[0]?.ref?.platform ?? batch.adSpends[0]?.ref?.platform ?? batch.commonExpenses[0]?.ref?.platform ??
    (request.platforms.length === 1 ? request.platforms[0] : undefined),
    scopeKey = request.scopeKeys[0];
  const candidates = rules.filter(rule => rule.kind === "ALLOCATION" && rule.active && rule.platform === platform && (!rule.scopeKey || rule.scopeKey === scopeKey) &&
    rule.validFrom.toISOString().slice(0, 10) <= date && (!rule.validTo || rule.validTo.toISOString().slice(0, 10) >= date)).filter(rule => {
      const payload = rule.payload as Record<string, unknown>;
      return payload.component === input.component && (payload.nameExact == null || payload.nameExact === normalizeProductName(input.name));
    });
  if (!candidates.length) return [initial];
  if (candidates.length !== 1) return [{ ...initial, quality: { ...input.quality, issues: uniq([...input.quality.issues, "AMBIGUOUS_ALLOCATION_RULE"]) } }];
  const payload = candidates[0].payload as { method: string; targets: Array<{ productName: string; weight: string | null }> };
  if (payload.method === "UNALLOCATED") return [initial];
  let targets: Array<{ productName: string; weight: string }>;
  if (payload.method === "FIXED_WEIGHTS") {
    targets = payload.targets.map(target => ({ productName: target.productName, weight: target.weight! }));
    // Weight values have 10 decimal places, unlike money's 6-place input boundary.
    if (!targets.reduce((sum, row) => sum.plus(row.weight), new D(0)).eq(1) || targets.some(row => new D(row.weight).lte(0)))
      throw new Error("INVALID_FIXED_ALLOCATION_WEIGHTS");
    targets = targets.map(target => ({ ...target, weight: new D(target.weight).mul("10000000000").toFixed(0) }));
  } else if (payload.method === "REVENUE_SHARE") {
    const selected = batch.sales.filter(sale => payload.targets.some(target => target.productName === sale.productName));
    if (selected.some(sale => sale.operatingRevenue === null)) return [{ ...initial, quality: { ...input.quality,
      issues: uniq([...input.quality.issues, "REVENUE_ALLOCATION_INCOMPLETE"]) } }];
    targets = payload.targets.map(target => ({ productName: target.productName,
      weight: quantizeMoney(selected.filter(sale => sale.productName === target.productName).reduce((sum, sale) => sum.plus(sale.operatingRevenue!), new D(0))) }));
    // Negative corrections are preserved in source totals; they are not valid distribution weights.
    if (targets.some(target => money(target.weight).isNegative())) return [{ ...initial, quality: { ...input.quality,
      issues: uniq([...input.quality.issues, "NON_POSITIVE_REVENUE_ALLOCATION_BASE"]) } }];
  } else throw new Error("INVALID_ALLOCATION_METHOD");
  const allocated = allocateProportionally(input.amount, targets);
  if (!allocated.length) return [{ ...initial, quality: { ...input.quality, issues: uniq([...input.quality.issues, "ZERO_ALLOCATION_BASE"]) } }];
  return allocated.map(row => ({ ...row, attribution: "ALLOCATED", quality: { ...input.quality, issues: uniq([...input.quality.issues, "EXPLICIT_ALLOCATION"]) } }));
}
