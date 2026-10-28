import { Prisma } from "@prisma/client";
import { normalizeProductName } from "./product-name-resolver";

const Decimal = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });

export type SaleUnitDefinition = {
  saleUnitName: string;
  optionExact?: string | null;
  optionInclude?: string[];
  unitsPerSaleUnit?: string | null;
  quantityBasis: "SALE_UNIT_TOTAL";
  salePrice?: string | null;
  productCost?: string | null;
  shippingCost?: string | null;
  otherCost?: string | null;
};

function decimalInput(value: unknown, precision: number, scale: number, field: string, positive = false) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error(`${field} must be a nonnegative plain decimal string.`);
  const decimal = new Decimal(value);
  if (decimal.decimalPlaces() > scale || decimal.gte(new Decimal(10).pow(precision - scale)) || positive && decimal.lte(0))
    throw new Error(`${field} exceeds numeric(${precision},${scale}) or is not positive.`);
  return decimal;
}

export function validateSaleUnit(definition: SaleUnitDefinition): void {
  if (!normalizeProductName(definition.saleUnitName) || definition.saleUnitName.length > 256)
    throw new Error("Sale unit name must be a nonempty string up to 256 characters.");
  if (definition.quantityBasis !== "SALE_UNIT_TOTAL") throw new Error("Costs must be totals for one sale unit.");
  if (definition.optionExact != null && typeof definition.optionExact !== "string") throw new Error("Exact option must be a string.");
  if (definition.optionInclude !== undefined && (!Array.isArray(definition.optionInclude) ||
      definition.optionInclude.some(t => typeof t !== "string" || !normalizeProductName(t))))
    throw new Error("Option conditions must be nonempty strings.");
  if (definition.unitsPerSaleUnit != null) decimalInput(definition.unitsPerSaleUnit, 24, 6, "unitsPerSaleUnit", true);
  for (const field of ["salePrice", "productCost", "shippingCost", "otherCost"] as const)
    if (definition[field] != null) decimalInput(definition[field], 30, 6, field);
}

/** Ordered sets drive prices/costs; physical count is descriptive and must not multiply set costs again. */
export function calculateSaleUnitQuantities(orderedQuantity: string, definition: SaleUnitDefinition) {
  validateSaleUnit(definition);
  const ordered = decimalInput(orderedQuantity, 24, 6, "orderedQuantity");
  const units = definition.unitsPerSaleUnit == null ? null : decimalInput(definition.unitsPerSaleUnit, 24, 6, "unitsPerSaleUnit", true);
  const physical = units ? ordered.mul(units) : null;
  if (physical) decimalInput(physical.toFixed(), 24, 6, "physicalQuantity");
  return {
    orderedQuantity: ordered.toFixed(), calculationQuantity: ordered.toFixed(),
    unitsPerSaleUnit: units?.toFixed() ?? null, physicalQuantity: physical?.toFixed() ?? null,
    quantityBasis: definition.quantityBasis
  };
}
