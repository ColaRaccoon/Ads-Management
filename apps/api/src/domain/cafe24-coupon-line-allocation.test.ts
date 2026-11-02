import test from "node:test";
import assert from "node:assert/strict";
import { allocateCafe24ProductCouponsToLines } from "./cafe24-coupon-line-allocation";
import { allocateNonNegativeByWeight } from "./cafe24-coupon-matcher";

test("mixed pages preserve the selected order coupon and each native product allocation", () => {
  for (const total of [1, 2, 1001]) for (const ids of [["a", "b", "c", "d"], ["z", "y", "x", "w"]]) {
    const lines = [{ id: ids[0], productId: "p", salePriceKrw: 1, quantity: 1, youtube: false },
      { id: ids[1], productId: "p", salePriceKrw: 2, quantity: 1, youtube: true },
      { id: ids[2], productId: "q", salePriceKrw: 3, quantity: 1, youtube: false },
      { id: ids[3], productId: "q", salePriceKrw: 5, quantity: 1, youtube: true }];
    const products = allocateNonNegativeByWeight(total, new Map([["p", 3], ["q", 8]]))!;
    const shares = allocateCafe24ProductCouponsToLines(products, lines)!;
    const sum = (selected: typeof lines) => selected.reduce((value, line) => value + shares.get(line.id)!, 0);
    assert.equal(sum(lines.filter(line => !line.youtube)) + sum(lines.filter(line => line.youtube)), total);
    assert.equal(sum(lines.filter(line => line.productId === "p")), products.get("p"));
    assert.equal(sum(lines.filter(line => line.productId === "q")), products.get("q"));
    assert.deepEqual(allocateCafe24ProductCouponsToLines(products, [...lines].reverse()), shares);
  }
});

test("missing or negative line weights remain unknown", () => {
  assert.equal(allocateCafe24ProductCouponsToLines(new Map([["p", 1]]), [{ id: "a", productId: "p", salePriceKrw: null, quantity: 1 }]), null);
  assert.equal(allocateCafe24ProductCouponsToLines(new Map([["p", 1]]), [{ id: "a", productId: "p", salePriceKrw: 1, quantity: -1 }]), null);
});
