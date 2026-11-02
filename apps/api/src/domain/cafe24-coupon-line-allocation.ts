import { allocateNonNegativeByWeight } from "./cafe24-coupon-matcher";

/** Split the already selected native product coupon across all sibling lines,
 * before channel filtering. Preserve each product's allocation and the order total. */
export function allocateCafe24ProductCouponsToLines(allocations: ReadonlyMap<string, number>,
  lines: readonly { id: string; productId: string | null; salePriceKrw: number | null; quantity: number }[]): Map<string, number> | null {
  const result = new Map(lines.map(line => [line.id, 0]));
  for (const [productId, deduction] of allocations) {
    const siblings = lines.filter(line => line.productId === productId);
    if (siblings.some(line => line.salePriceKrw === null || !Number.isFinite(line.salePriceKrw) ||
      !Number.isFinite(line.quantity) || line.salePriceKrw < 0 || line.quantity < 0)) return null;
    if (deduction === 0) continue;
    const shares = allocateNonNegativeByWeight(deduction, new Map(siblings.map(line => [line.id, line.salePriceKrw! * line.quantity])));
    if (!shares) return null;
    for (const [id, amount] of shares) result.set(id, amount);
  }
  return result;
}
