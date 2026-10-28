import { Prisma } from "@prisma/client";
import type { DecimalString } from "../types";

/** Separate constructor: existing calculators' rounding settings are untouched. */
export const ExactDecimal = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });
export function decimal(value: unknown): Prisma.Decimal {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 160)
    throw new Error("Expected a finite, non-exponential decimal string.");
  return new ExactDecimal(value);
}
export function boundedDecimal(value: unknown, precision: number, scale: number): Prisma.Decimal {
  const result = decimal(value);
  if (result.decimalPlaces() > scale || result.abs().gte(new ExactDecimal(10).pow(precision - scale)))
    throw new Error(`Decimal exceeds numeric(${precision},${scale}).`);
  return result;
}
export const money = (value: unknown) => boundedDecimal(value, 30, 6);
export const quantity = (value: unknown) => boundedDecimal(value, 24, 6);
export const ratio = (value: unknown) => boundedDecimal(value, 18, 10);
export function quantizeMoney(value: Prisma.Decimal): DecimalString {
  const quantized = value.toDecimalPlaces(6, ExactDecimal.ROUND_HALF_UP);
  money(quantized.toFixed(6));
  return quantized.toFixed(6);
}
export function microsToAmount(micros: string): DecimalString {
  if (!/^-?(?:0|[1-9]\d*)$/.test(micros)) throw new Error("Micros must be an integer string.");
  return quantizeMoney(decimal(micros).div(1000000));
}

export interface WeightedTarget { key: string; weight: DecimalString }
/** Preserve signed amounts; residual order is fractional remainder desc then stable business key. */
export function allocateMoney(amount: DecimalString, targets: readonly WeightedTarget[], scale = 6) {
  if (![0, 6].includes(scale)) throw new Error("Allocation scale must be 0 or 6.");
  const input = money(amount);
  if (new Set(targets.map(t => t.key)).size !== targets.length || targets.some(t => !t.key))
    throw new Error("Allocation keys must be nonempty and unique.");
  const weights = targets.map(t => ({ ...t, value: ratio(t.weight) }));
  if (weights.some(t => t.value.isNegative())) throw new Error("Negative allocation weight.");
  const sum = weights.reduce((s, t) => s.plus(t.value), new ExactDecimal(0));
  if (!targets.length || sum.isZero()) return { assigned: [] as { key: string; amount: string }[], unallocated: amount };
  if (!sum.eq(1)) throw new Error("Allocation weights must sum to 1.");
  const quantum = new ExactDecimal(10).pow(-scale);
  const targetTotal = input.abs().toDecimalPlaces(scale, ExactDecimal.ROUND_HALF_UP);
  const rows = weights.map(t => {
    const exact = targetTotal.mul(t.value);
    const base = exact.toDecimalPlaces(scale, ExactDecimal.ROUND_DOWN);
    return { key: t.key, base, remainder: exact.minus(base) };
  });
  let remaining = targetTotal.minus(rows.reduce((s, t) => s.plus(t.base), new ExactDecimal(0)));
  rows.sort((a, b) => b.remainder.cmp(a.remainder) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const row of rows) {
    if (remaining.lt(quantum)) break;
    row.base = row.base.plus(quantum);
    remaining = remaining.minus(quantum);
  }
  if (!remaining.isZero()) throw new Error("Unresolved allocation residual.");
  const assigned = rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(t => ({ key: t.key, amount: (input.isNegative() ? t.base.negated() : t.base).toFixed(scale) }));
  // Preserve source precision if a source's own rounding policy requests whole-won allocation.
  const total = assigned.reduce((s, t) => s.plus(t.amount), new ExactDecimal(0));
  return { assigned, unallocated: input.minus(total).toFixed(6) };
}
