import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { calculateSaleUnitQuantities, SaleUnitDefinition, validateSaleUnit } from "./sale-unit-validation";

const set: SaleUnitDefinition = { saleUnitName: "1+1 세트", unitsPerSaleUnit: "2", quantityBasis: "SALE_UNIT_TOTAL", salePrice: "34900", productCost: "9000", shippingCost: "0", otherCost: "0" };

test("two 1+1 sets charge two set costs, not four; physical count remains separate", () => {
  const quantity = calculateSaleUnitQuantities("2", set);
  assert.equal(quantity.calculationQuantity, "2");
  assert.equal(quantity.physicalQuantity, "4");
  assert.equal(new Prisma.Decimal(set.productCost!).mul(quantity.calculationQuantity).toFixed(), "18000");
});

test("unknown physical size and missing cost remain null, explicit zero is valid", () => {
  const quantity = calculateSaleUnitQuantities("0", { ...set, unitsPerSaleUnit: null, productCost: null });
  assert.equal(quantity.physicalQuantity, null);
  assert.equal(quantity.calculationQuantity, "0");
  assert.doesNotThrow(() => validateSaleUnit({ ...set, productCost: "0" }));
});

test("plain decimal boundaries and physical multiplication reject unsafe values", () => {
  for (const productCost of ["1e3", "NaN", "-1", "1000000000000000000000000", "1.0000001"])
    assert.throws(() => validateSaleUnit({ ...set, productCost }));
  for (const unitsPerSaleUnit of ["0", "-1", "1000000000000000000", "0.0000001"])
    assert.throws(() => validateSaleUnit({ ...set, unitsPerSaleUnit }));
  assert.throws(() => calculateSaleUnitQuantities("999999999999999999", set));
  assert.equal(calculateSaleUnitQuantities("999999999999999999.123456", { ...set, unitsPerSaleUnit: "1" }).physicalQuantity, "999999999999999999.123456");
});
