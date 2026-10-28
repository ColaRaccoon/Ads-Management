import assert from "node:assert/strict";
import test from "node:test";
import { CatalogProduct, NameInput, NameRule, normalizeProductName, resolveProductName } from "./product-name-resolver";

const products: CatalogProduct[] = [{ canonicalName: "버닝웨이브바" }, { canonicalName: "쿨토시" }, { canonicalName: "카프슬리브" }];
const input = (overrides: Partial<NameInput> = {}): NameInput => ({ originalName: "버닝웨이브바", nameField: "product_name", platform: "CAFE24", scopeKey: "shop1", businessDate: "2026-10-27", ...overrides });
const rule = (overrides: Partial<NameRule> = {}): NameRule => ({ id: "rule-1", canonicalProductName: "버닝웨이브바", matchType: "EXACT", terms: ["버닝 웨이브바"], validFrom: "2026-10-20", ...overrides });
const resolve = (row = input(), rules: NameRule[] = []) => resolveProductName(row, products, rules, "names-v1");

test("NFC and English case/whitespace normalization preserve symbols, sizes, digits and set counts", () => {
  assert.equal(normalizeProductName("  러닝  PORON  500ml 1+1_A  "), "러닝 poron 500ml 1+1_a");
  assert.equal(normalizeProductName("가".normalize("NFD")), "가");
  assert.notEqual(normalizeProductName("버닝 슬라이드"), normalizeProductName("버닝슬라이드"));
  assert.notEqual(normalizeProductName("500ml"), normalizeProductName("50ml"));
});

test("reissued platform IDs are irrelevant while renamed same-ID input invalidates evidence", () => {
  const one = { ...input(), externalId: "old-platform-id" };
  const two = { ...input(), externalId: "new-platform-id" };
  assert.deepEqual(resolve(one), resolve(two));
  const renamed = resolve({ ...one, originalName: "쿨토시" });
  assert.equal(renamed.canonicalProductName, "쿨토시");
  assert.notEqual(renamed.nameInputHash, resolve(one).nameInputHash);
});

test("exact aliases are scoped, dated, option constrained and preserve input snapshots", () => {
  const alias = rule({ platform: "CAFE24", scopeKey: "shop1", optionExact: "1+1", validTo: "2026-10-27", saleUnitName: "1+1 세트" });
  const matched = resolve(input({ originalName: "  버닝 웨이브바 ", originalOption: "1+1" }), [alias]);
  assert.equal(matched.matchStatus, "MATCHED");
  assert.equal(matched.saleUnitName, "1+1 세트");
  assert.equal(matched.originalName, "  버닝 웨이브바 ");
  for (const change of [{ scopeKey: "shop2" }, { platform: "NAVER" as const }, { businessDate: "2026-10-28" }, { originalOption: "단품" }])
    assert.equal(resolve(input({ originalName: "버닝 웨이브바", originalOption: "1+1", ...change }), [alias]).matchStatus, "UNMATCHED");
  assert.equal(resolve(input({ originalName: "버닝 웨이브바", originalOption: "1+1", businessDate: "2026-10-20" }), [alias]).matchStatus, "MATCHED");
});

test("all contains candidates are evaluated, with exclusion and exact tier precedence", () => {
  const first = rule({ matchType: "CONTAINS", terms: ["보호", "러닝"], excludeTerms: ["아동"], optionInclude: ["성인"], optionExclude: ["소형"] });
  const row = input({ originalName: "러닝 보호 신상품", originalOption: "성인 대형" });
  assert.equal(resolve(row, [first]).canonicalProductName, "버닝웨이브바");
  assert.equal(resolve({ ...row, originalName: "아동 러닝 보호" }, [first]).matchStatus, "UNMATCHED");
  assert.equal(resolve({ ...row, originalOption: "성인 소형" }, [first]).matchStatus, "UNMATCHED");
  const second = rule({ id: "rule-2", canonicalProductName: "쿨토시", matchType: "CONTAINS", terms: ["러닝"] });
  assert.equal(resolve(row, [first, second]).matchStatus, "AMBIGUOUS");
  assert.equal(resolve(row, [second, first]).nameInputHash, resolve(row, [first, second]).nameInputHash);
  const exact = rule({ id: "exact", canonicalProductName: "카프슬리브", terms: ["러닝 보호 신상품"] });
  assert.equal(resolve(row, [first, second, exact]).canonicalProductName, "카프슬리브");
});

test("different canonical products colliding after normalization are never selected arbitrarily", () => {
  const result = resolveProductName(input({ originalName: "PRO" }), [{ canonicalName: "PRO" }, { canonicalName: "pro" }], [], "v1");
  assert.equal(result.matchStatus, "AMBIGUOUS");
  assert.deepEqual(result.candidateNames, ["PRO", "pro"]);
  assert.deepEqual(result.reasons, ["CANONICAL_NORMALIZATION_COLLISION"]);
});

test("set units stay separate and unresolved unit returns UNIT_REQUIRED with product evidence", () => {
  const rows = [rule({ id: "one", terms: ["별칭"], saleUnitName: "단품" }), rule({ id: "two", terms: ["별칭"], saleUnitName: "1+1" })];
  assert.equal(resolve(input({ originalName: "별칭" }), rows).matchStatus, "UNIT_REQUIRED");
  assert.equal(resolve(input({ originalName: "별칭", saleUnitName: "1+1" }), rows).saleUnitName, "1+1");
  const required = resolve(input({ requiresSaleUnit: true }));
  assert.equal(required.matchStatus, "UNIT_REQUIRED");
  assert.equal(required.canonicalProductName, "버닝웨이브바");
  const withUnit = resolve(input(), [rule({ id: "unit-rule", matchType: "CONTAINS", terms: ["버닝"], saleUnitName: "단품" })]);
  assert.equal(withUnit.saleUnitName, "단품");
  assert.deepEqual(withUnit.ruleIds, ["unit-rule"]);
});

test("missing names, similar product names and invalid dates remain explicit", () => {
  assert.equal(resolve(input({ originalName: "  " })).matchStatus, "NAME_MISSING");
  assert.equal(resolve(input({ originalName: "카프슬리브 신형" })).matchStatus, "UNMATCHED");
  assert.equal(resolve(input({ originalName: "카프슬리브" })).canonicalProductName, "카프슬리브");
  assert.throws(() => resolve(input({ businessDate: "2026-02-30" })), /date/);
  assert.throws(() => resolve(input(), [rule({ terms: [" "] })]), /terms/);
  assert.notEqual(resolve(input()).nameInputHash, resolveProductName(input(), products, [], "names-v2").nameInputHash);
});

test("inactive products retain only effective explicit historical rules and still participate in collisions", () => {
  const catalog = [{ canonicalName: "옛제품", active: false }, { canonicalName: "새제품", active: true }];
  const historical = rule({ canonicalProductName: "옛제품", terms: ["옛제품"], validFrom: "2026-01-01", validTo: "2026-10-26" });
  const historicalInput = input({ originalName: "옛제품", businessDate: "2026-10-26" });
  assert.equal(resolveProductName(historicalInput, catalog, [], "v1").matchStatus, "UNMATCHED");
  assert.equal(resolveProductName(historicalInput, catalog, [historical], "v1").canonicalProductName, "옛제품");
  assert.equal(resolveProductName({ ...historicalInput, businessDate: "2026-10-27" }, catalog, [historical], "v1").matchStatus, "UNMATCHED");
  const conflicting = rule({ id: "collision", canonicalProductName: "옛제품", terms: ["새제품"] });
  assert.equal(resolveProductName(input({ originalName: "새제품" }), catalog, [conflicting], "v1").matchStatus, "AMBIGUOUS");
});
