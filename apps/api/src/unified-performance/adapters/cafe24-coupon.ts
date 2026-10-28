import { ExactDecimal as D, money, quantizeMoney } from "../domain/decimal";
type Decimal = InstanceType<typeof D>;

export interface Cafe24CouponInput {
  key: string; productName: string | null; date: string; signal: boolean | null;
  total: string | null; paid: string | null; weight: string; valid: boolean;
}
export interface Cafe24CouponPolicy {
  id: string; productName: string | null; scope: "GLOBAL" | "PRODUCT"; amount: string;
  from: string; to: string | null; priority: number; createdAt: string;
}

/** Decimal counterpart of the legacy order matcher; allocation is to source lines,
 * before any product filtering, and never to every line's full order discount. */
export function cafe24OrderCoupon(lines: Cafe24CouponInput[], rules: Cafe24CouponPolicy[]) {
  const empty = (status: string, amount: string | null, issues: string[] = []) => ({
    status, amount, ruleId: null as string | null, estimated: false, issues,
    allocations: new Map(lines.map(l => [l.key, amount === "0" ? "0" : null] as const))
  });
  if (!lines.length || lines.some(l => l.signal === null) || new Set(lines.map(l => l.signal)).size > 1)
    return empty("UNKNOWN", null, ["COUPON_SIGNAL_UNKNOWN"]);
  if (!lines[0].signal) return empty("NO_COUPON", "0");
  if (lines.some(l => !l.valid || l.total === null || l.paid === null || !l.productName))
    return empty("UNKNOWN", null, ["COUPON_ORDER_CONTEXT_INCOMPLETE"]);
  if (new Set(lines.map(l => l.date)).size !== 1 ||
      ["total", "paid"].some(field => {
        const amounts = lines.map(l => money(l[field as "total" | "paid"]!));
        return D.max(...amounts).minus(D.min(...amounts)).gt(1);
      })) return empty("UNKNOWN", null, ["COUPON_ORDER_CONTEXT_INCONSISTENT"]);
  const gap = money(lines[0].total!).minus(lines[0].paid!);
  if (gap.lte(0)) return empty("UNMATCHED", null, ["COUPON_NON_POSITIVE_GAP"]);
  const products = new Set(lines.map(l => l.productName));
  const candidates = rules.filter(r => r.from <= lines[0].date && (!r.to || r.to >= lines[0].date) &&
    money(r.amount).gt(0) && (r.scope === "GLOBAL" && r.productName === null || r.scope === "PRODUCT" && products.has(r.productName)));
  const exact = candidates.filter(r => money(r.amount).minus(gap).abs().lte(1));
  const plausible = exact.length ? exact : candidates.filter(r => money(r.amount).lte(gap.plus(1)));
  if (!plausible.length) return empty("UNMATCHED", null, ["COUPON_NO_PLAUSIBLE_RULE"]);
  plausible.sort((a, b) => (exact.length ? money(a.amount).minus(gap).abs().cmp(money(b.amount).minus(gap).abs()) : 0) ||
    money(b.amount).cmp(a.amount) || (a.scope === b.scope ? 0 : a.scope === "PRODUCT" ? -1 : 1) ||
    a.priority - b.priority || b.from.localeCompare(a.from) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const rule = plausible[0];
  const targets = lines.filter(l => rule.scope === "GLOBAL" || l.productName === rule.productName);
  const weightsByProduct = new Map<string, Decimal>();
  for (const line of targets) weightsByProduct.set(line.productName!,
    (weightsByProduct.get(line.productName!) ?? new D(0)).plus(D.max(0, money(line.weight))));
  if ([...weightsByProduct.values()].reduce((s, value) => s.plus(value), new D(0)).lte(0))
    return empty("UNKNOWN", null, ["COUPON_NON_POSITIVE_ALLOCATION_BASE"]);
  const scale = money(rule.amount).isInteger() ? 0 : 2;
  // Preserve the existing product-level allocation before splitting a product's
  // share across source lines. Splitting an order item must not move a won of
  // discount to another product merely by adding another rounding candidate.
  const productShares = allocate(money(rule.amount), [...weightsByProduct].map(([key, weight]) => ({ key, weight })), scale);
  const allocations = new Map(lines.map(l => [l.key, "0" as string | null]));
  for (const [productName, amount] of productShares) {
    const productLines = targets.filter(line => line.productName === productName);
    if (amount.isZero()) continue;
    for (const [key, share] of allocate(amount, productLines.map(line => ({ key: line.key, weight: D.max(0, money(line.weight)) })), scale))
      allocations.set(key, quantizeMoney(share));
  }
  const ignored = gap.minus(rule.amount);
  return { status: "APPLIED", amount: rule.amount, ruleId: rule.id, estimated: ignored.abs().gt(1),
    issues: ignored.gt(1) ? ["COUPON_IGNORED_RESIDUAL"] : [], allocations };
}

function allocate(amount: Decimal, weights: Array<{ key: string; weight: Decimal }>, scale: number): Map<string, Decimal> {
  const totalWeight = weights.reduce((sum, line) => sum.plus(line.weight), new D(0));
  const quantum = new D(10).pow(-scale);
  const shares = weights.map(l => {
    const exact = amount.mul(l.weight).div(totalWeight);
    const base = exact.toDecimalPlaces(scale, D.ROUND_DOWN);
    return { key: l.key, base, remainder: exact.minus(base) };
  }).sort((a, b) => b.remainder.cmp(a.remainder) || a.key.localeCompare(b.key));
  let residual = amount.minus(shares.reduce((s, r) => s.plus(r.base), new D(0)));
  for (const share of shares) if (residual.gte(quantum)) { share.base = share.base.plus(quantum); residual = residual.minus(quantum); }
  if (!residual.isZero()) throw new Error("Unresolved Cafe24 coupon allocation residual.");
  return new Map(shares.map(share => [share.key, share.base]));
}
