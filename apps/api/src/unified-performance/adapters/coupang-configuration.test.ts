import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductName } from "../domain/product-name-resolver";
import { coupangConfiguration, coupangProductIdentity, type CoupangConfigurationInput, type CoupangLegacyCostRule } from "./coupang-configuration";

const base = (): CoupangConfigurationInput => ({ date: "2026-10-26", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD",
  products: [{ id: "old-id", standardName: "버닝웨이브바 2개입", displayName: "버닝웨이브바 2개입", isActive: true }],
  rules: [{ id: "rule", productId: "old-id", includeKeywords: ["버닝 웨이브바", "2개"], excludeKeywords: ["3개"],
    validFrom: "2026-10-01", validTo: "2026-10-26", adEnabled: true, isActive: true }],
  costs: [], observedSales: [{ productName: "파티마 버닝웨이브바", optionName: "2개입" }],
  observedAds: [{ adExecutionProductName: "파티마 버닝웨이브바 2개입" }] });
const resolve = (input: CoupangConfigurationInput, name: string, option = "", field = "product_name") => {
  const config = coupangConfiguration(input);
  return resolveProductName({ originalName: name, originalOption: option, nameField: field, platform: "COUPANG",
    scopeKey: input.scopeKey, businessDate: input.date }, config.products, config.nameRules, "test-version");
};
const cost = (): CoupangLegacyCostRule => ({ id: "cost-id", productId: "old-id", from: "2026-10-01", to: null,
  productCostKrw: "8000.00", sellerShippingFeeKrw: "2800.00", hanaroShippingFeeKrw: "400.00",
  growthInboundFeeKrw: "1200.00", growthShippingFeeKrw: "2200.00", returnRate: "0.05",
  returnCostPerUnitKrw: "2500.00", extraCostKrw: "0.00", salePriceKrw: "29800.00" });

test("only established aliases merge products and explicitly preserve sale-unit quantities", () => {
  assert.deepEqual(coupangProductIdentity("버닝웨이브바 2개입"), { productName: "버닝웨이브바", saleUnitName: "2개입", unitsPerSaleUnit: "2" });
  assert.equal(coupangProductIdentity("플로우라이트_1개입").productName, "플로우라이트");
  assert.equal(coupangProductIdentity("한줄보호대 4개입").saleUnitName, "4개입");
  assert.equal(coupangProductIdentity("두줄보호대").productName, "두줄무릎보호대");
  assert.equal(coupangProductIdentity("카프슬리브 2개입").productName, "카프슬리브 2개입");
  assert.equal(coupangProductIdentity("버닝웨이브바 3개입").productName, "버닝웨이브바 3개입");
});

test("legacy include/exclude predicates use observed names and options without external IDs", () => {
  const config = base();
  const sale = resolve(config, "파티마 버닝웨이브바", "2개입");
  assert.equal(sale.canonicalProductName, "버닝웨이브바"); assert.equal(sale.saleUnitName, "2개입");
  const renamedIds = { ...config, products: config.products.map(product => ({ ...product, id: "new-id" })),
    rules: config.rules.map(rule => ({ ...rule, productId: "new-id" })) };
  assert.equal(resolve(renamedIds, "파티마 버닝웨이브바", "2개입").canonicalProductName, sale.canonicalProductName);
  const excluded = { ...config, observedSales: [{ productName: "파티마 버닝웨이브바 3개", optionName: "2개입" }] };
  assert.equal(resolve(excluded, "파티마 버닝웨이브바 3개", "2개입").matchStatus, "UNMATCHED");
});

test("legacy adEnabled and rule dates apply to execution names only", () => {
  const data = base();
  assert.equal(resolve(data, "파티마 버닝웨이브바 2개입", "", "ad_execution_product_name").canonicalProductName, "버닝웨이브바");
  data.rules = data.rules.map(rule => ({ ...rule, adEnabled: false }));
  assert.equal(resolve(data, "파티마 버닝웨이브바 2개입", "", "ad_execution_product_name").matchStatus, "UNMATCHED");
  assert.equal(resolve(data, "파티마 버닝웨이브바", "2개입").canonicalProductName, "버닝웨이브바");
  data.date = "2026-10-27";
  assert.equal(resolve(data, "파티마 버닝웨이브바", "2개입").matchStatus, "UNMATCHED");
});

test("overlapping legacy candidates are preserved instead of selecting a preferred product ID", () => {
  const data = base();
  data.products = [...data.products, { id: "other", standardName: "독립제품", displayName: "독립제품" }];
  data.rules = [...data.rules, { ...data.rules[0], id: "other-rule", productId: "other" }];
  const result = resolve(data, "파티마 버닝웨이브바", "2개입");
  assert.equal(result.matchStatus, "AMBIGUOUS"); assert.deepEqual(result.candidateNames, ["독립제품", "버닝웨이브바"]);
});

test("cost histories retain full-unit costs and canonical names after a source-ID replacement", () => {
  const data = { ...base(), costs: [cost()] };
  const before = coupangConfiguration(data).costRules[0];
  assert.equal(before.productName, "버닝웨이브바"); assert.equal(before.saleUnitName, "2개입");
  assert.equal(before.productCostKrw, "8000.00"); assert.equal(before.unitsPerSaleUnit, "2");
  const after = coupangConfiguration({ ...data, products: data.products.map(product => ({ ...product, id: "new-id" })),
    costs: [{ ...cost(), productId: "new-id" }] }).costRules[0];
  assert.deepEqual({ ...after, historyKey: before.historyKey }, before);
  assert.equal(before.historyKey, "old-id"); assert.equal(after.historyKey, "new-id");
  assert.equal(coupangConfiguration({ ...data, costs: [{ ...cost(), productCostKrw: null }] }).costRules[0].productCostKrw, null);
});

test("same-name legacy settings keep separate history lineages instead of collapsing to the newest product ID", () => {
  const data = base();
  data.products = [...data.products, { ...data.products[0], id: "second-id" }];
  data.costs = [cost(), { ...cost(), id: "cost-newer", productId: "second-id", from: "2026-10-25", productCostKrw: "9000" }];
  const transformed = coupangConfiguration(data).costRules;
  assert.equal(transformed.length, 2); assert.equal(new Set(transformed.map(rule => rule.productName)).size, 1);
  assert.deepEqual(transformed.map(rule => rule.historyKey).sort(), ["old-id", "second-id"]);
});

test("native unified rules are preserved alongside legacy name materialization", () => {
  const data = base();
  data.unified = { products: [{ id: "u", canonicalName: "새제품", active: true }], rules: [{ id: "u-rule", productId: "u", kind: "NAME",
    payload: { matchType: "EXACT", terms: ["유효한 별칭"] }, platform: "COUPANG", scopeKey: data.scopeKey,
    validFrom: "2026-01-01", validTo: null, active: true }] };
  const result = resolve(data, "유효한 별칭");
  assert.equal(result.canonicalProductName, "새제품");
  assert.throws(() => coupangConfiguration({ ...data, scopeKey: "mixed-account" }), /configuration scope/);
});
