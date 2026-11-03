import assert from "node:assert/strict";
import test from "node:test";
import type { NativeStoredResult } from "../native-result-contract";
import { mapNativeProducts, mappingPlatform, NATIVE_NAME_FIELDS, resolveNativeProduct } from "./native-product-mapping";
import type { NameRule } from "./product-name-resolver";
import { prepareNativeResultFacts, summarizeNativeResults } from "./stored-result-projection";

const products = ["두줄무릎보호대", "두줄보호대 2개입", "베놈무릎보호대", "베놈공용", "베놈여성", "버닝웨이브바"].map(canonicalName => ({ canonicalName, active: true }));
const rule = (terms = ["두줄보호대 2개입"], canonicalProductName = "두줄무릎보호대"): NameRule => ({
  id: "link", canonicalProductName, matchType: "EXACT", terms, platform: "COUPANG", scopeKey: "shop",
  nameField: "native:COUPANG", validFrom: "2026-10-01", validTo: "2026-10-31", active: true
});
const amount = (value: string | null) => ({ known: value, complete: value });
const row = (name: string | null, kind: "PRODUCT" | "SUMMARY" = "PRODUCT"): NativeStoredResult => ({
  kind, group: "COUPANG", productKey: name ?? "SUMMARY", productName: name, quantity: "2", revenue: amount("100000.123456789"),
  adSpend: amount("10000"), netProfit: amount(null), profitBeforeAds: amount("30000"), issues: [], sourceUpdatedAt: null
});
test("explicit final-result links group existing canonical products while preserving every source amount, unit and key", () => {
  const input = [row(null, "SUMMARY"), row("두줄보호대 2개입")], before = structuredClone(input);
  const mapped = mapNativeProducts(input, "shop", "2026-10-20", products, [rule()], "v1");
  assert.equal(mapped[0], input[0]); assert.equal(mapped[1].productName, "두줄무릎보호대");
  const { productName, audit, ...source } = mapped[1];
  const { productName: oldName, ...original } = input[1];
  assert.deepEqual(source, original); assert.equal(audit?.sourceProductName, oldName);
  assert.equal(audit?.mappingRuleIds, "link"); assert.deepEqual(input, before);
});
test("each final source and advertising platform supports an independently scoped exact link", () => {
  for (const [group, nameField] of Object.entries(NATIVE_NAME_FIELDS)) {
    const platform = mappingPlatform(group as keyof typeof NATIVE_NAME_FIELDS);
    const r = { ...rule(), platform, nameField };
    assert.equal(resolveNativeProduct("두줄보호대 2개입", group as keyof typeof NATIVE_NAME_FIELDS, "shop", "2026-10-20", products, [r], "v").canonicalProductName, "두줄무릎보호대");
  }
});
test("dated, inactive and foreign-scope links cannot reclassify rows; ordinary catalog collision semantics remain", () => {
  for (const [scope, day, rules] of [["other", "2026-10-20", [rule()]], ["shop", "2026-11-01", [rule()]], ["shop", "2026-10-20", [{ ...rule(), active: false }]]] as const) {
    assert.equal(mapNativeProducts([row("두줄보호대 2개입")], scope, day, products, rules, "v")[0].productName, "두줄보호대 2개입");
  }
  const ordinary = { ...rule(), nameField: null };
  assert.equal(resolveNativeProduct("두줄보호대 2개입", "COUPANG", "shop", "2026-10-20", products, [ordinary], "v").matchStatus, "AMBIGUOUS");
});
test("conflicting links never choose a product arbitrarily; original source name supports subsequent remapping", () => {
  const rules = [rule(), { ...rule(), id: "other", canonicalProductName: "베놈무릎보호대" }];
  const bad = mapNativeProducts([row("두줄보호대 2개입")], "shop", "2026-10-20", products, rules, "v1")[0];
  assert.equal(bad.productName, null); assert.ok(bad.issues.includes("NATIVE_PRODUCT_MAPPING_AMBIGUOUS"));
  const fixed = mapNativeProducts([bad], "shop", "2026-10-20", products, [rule()], "v2")[0];
  assert.equal(fixed.productName, "두줄무릎보호대"); assert.equal(fixed.audit?.sourceProductName, "두줄보호대 2개입");
});
test("two Venom variants aggregate under one product without double counting platform summary or changing null net", () => {
  const rows = [row(null, "SUMMARY"), row("베놈공용"), row("베놈여성")];
  const rules = [rule(["베놈공용"], "베놈무릎보호대"), { ...rule(["베놈여성"], "베놈무릎보호대"), id: "female" }];
  const facts = (input: NativeStoredResult[]) => prepareNativeResultFacts(input).map(fact => ({ ...fact, platform: "COUPANG" as const, scopeKey: "shop", date: "2026-10-20" }));
  const before = facts(rows), after = facts(mapNativeProducts(rows, "shop", "2026-10-20", products, rules, "v"));
  assert.equal(summarizeNativeResults(before, [], { platforms: ["COUPANG"], productName: "베놈무릎보호대" }).knownTotals.revenue, "0.000000");
  const product = summarizeNativeResults(after, [], { platforms: ["COUPANG"], productName: "베놈무릎보호대" });
  assert.equal(product.knownTotals.revenue, "200000.246914"); assert.equal(product.knownTotals.estimatedProfit, null);
  assert.deepEqual(summarizeNativeResults(before, [], { platforms: ["COUPANG"] }).knownTotals, summarizeNativeResults(after, [], { platforms: ["COUPANG"] }).knownTotals);
});
