import assert from "node:assert/strict";
import test from "node:test";
import { ExactDecimal as D } from "../domain/decimal";
import { CONTRACT_VERSION, type AdapterRequest } from "../types";
import { normalizeNaverSalesDay, selectNaverCost, type NaverSalesDayInput, type NaverOrderRow, type NaverSalesUnit,
  type NaverCostSetting } from "./naver-sales";
import { naverConfiguration } from "./naver-configuration";

const date = "2026-10-26", at = `${date}T12:00:00+09:00`, scopeKey = "store-a";
const request = (): AdapterRequest => ({ contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: date, to: date,
  scopeKeys: [scopeKey], platforms: ["NAVER"], scopePolicyVersion: "scope", nameRuleVersion: "names", saleUnitRuleVersion: "units",
  allocationRuleVersion: "allocation", calculationVersion: "naver-profit-v2-preserved", fxVersion: "fx", sourcePolicySnapshot: {},
  sourceWatermarks: {}, cursor: null, limit: 100 });
const unit = (changes: Partial<NaverSalesUnit> = {}): NaverSalesUnit => ({ id: "unit", displayName: "버닝웨이브바", matchAliases: [],
  parentSalesUnitId: null, isGroup: false, ...changes });
const row = (changes: Partial<NaverOrderRow> = {}): NaverOrderRow => ({ id: "row1", externalProductOrderId: "product-order1",
  orderSourceSignatureId: null, canonicalSalesUnitId: "unit", rawProductName: "버닝웨이브바", rawOptionInfo: null,
  paymentDate: date, saleStatus: "SALE", quantity: "2", productPaymentAmount: "20000", paymentCommission: "100",
  knowledgeShoppingSellingInterlockCommission: "200", saleCommission: "50", channelCommission: "0", updatedAt: at, ...changes });
const manual = (changes: Partial<NaverCostSetting> = {}): NaverCostSetting => ({ id: "manual", canonicalSalesUnitId: "unit",
  unitCost: "2000", otherCost: "100", feeRate: "0.1", isActive: true, effectiveFrom: "2026-01-01", effectiveTo: null,
  updatedAt: at, ...changes });
const input = (changes: Partial<NaverSalesDayInput> = {}): NaverSalesDayInput => ({ date, scopeKey, observedAt: at, collectedAt: at,
  sourceVersion: "source", complete: true, sourceIssues: [], rows: [row()], signatures: [], salesUnits: [unit()],
  costSettings: [manual()], costSnapshots: [], costEntries: [], configuration: {
    products: [{ canonicalName: "버닝웨이브바" }, { canonicalName: "플로우라이트" }], nameRules: [] }, ...changes });
const total = (values: (string | null)[]) => values.reduce((acc, value) => acc.plus(value!), new D(0)).toFixed(6);

test("Naver SALE payment amount keeps fees, costs and group-day VAT separate without ad/refund re-deduction", () => {
  const batch = normalizeNaverSalesDay(request(), input()), sale = batch.sales[0];
  assert.equal(sale.operatingRevenue, "20000.000000");
  assert.equal(sale.productCost, "4000.000000"); assert.equal(sale.otherDirectCost, "200.000000");
  assert.equal(sale.platformFee, "350.000000"); assert.equal(sale.vatExpense, "2000.000000");
  assert.equal(sale.profitBeforeAds, "13450.000000"); assert.equal(sale.directShippingCost, "0.000000");
  assert.equal(sale.feePresenceMask, "1111"); assert.equal(batch.commonExpenses.length, 0); assert.equal(batch.adSpends.length, 0);
  assert.ok(batch.sourceControlTotals.every(c => c.difference === "0.000000"));
  assert.equal(sale.quality.isEstimate, true); assert.equal(batch.coverage[0].collectionState, "COMPLETE");
});

test("Naver restores omitted names/options from signature and preserves distinct same-name orders", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, orderSourceSignatureId: "s" }),
    row({ id: "new-row", externalProductOrderId: "new-order", canonicalSalesUnitId: null, rawProductName: null, orderSourceSignatureId: "s" })],
    signatures: [{ id: "s", rawProductNameSnapshot: "버닝웨이브바", rawOptionInfoSnapshot: "단품" }] }));
  assert.equal(batch.sales.length, 2); assert.equal(total(batch.sales.map(s => s.operatingRevenue)), "40000.000000");
  assert.ok(batch.sales.every(s => s.productName === "버닝웨이브바" && s.productCost === "4000.000000"));
  assert.equal(batch.sales[0].name.restorationPath, "public.order_source_signatures.rawProductNameSnapshot");
  assert.equal(batch.sales[0].optionName, "단품"); assert.equal(batch.sales[0].name.nameInputHash, batch.sales[1].name.nameInputHash);
});

test("Naver source names override stale canonical reference, ID changes need no mapping and ambiguous aliases never pick first", () => {
  const renamed = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: "플로우라이트" })],
    salesUnits: [unit(), unit({ id: "newunit", displayName: "플로우라이트" })],
    costSettings: [manual(), manual({ id: "newcost", canonicalSalesUnitId: "newunit", unitCost: "500" })] })).sales[0];
  assert.equal(renamed.productName, "플로우라이트"); assert.equal(renamed.productCost, "1000.000000");
  const ambiguous = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: "공통별칭" })],
    salesUnits: [unit({ matchAliases: ["공통별칭"] }), unit({ id: "u2", displayName: "플로우라이트", matchAliases: ["공통별칭"] })] })).sales[0];
  assert.equal(ambiguous.productName, null); assert.equal(ambiguous.productCost, null);
  assert.ok(ambiguous.quality.issues.includes("SALE_UNIT_AMBIGUOUS"));
});

test("Naver internal reference restores a readable sale-unit name for verbose source names without using external product IDs", () => {
  const source = row({ rawProductName: null, orderSourceSignatureId: "signature", rawOptionInfo: "옵션2.검정", canonicalSalesUnitId: "unit" });
  const signatures = [{ id: "signature", rawProductNameSnapshot: "광고 문구가 붙은 오래된 상품 제목", rawOptionInfoSnapshot: "옵션2.검정" }];
  const original = normalizeNaverSalesDay(request(), input({ rows: [source], signatures })).sales[0];
  assert.equal(original.productName, null); assert.equal(original.productCost, "4000.000000");
  assert.equal(original.name.originalName, signatures[0].rawProductNameSnapshot); assert.equal(original.name.originalOption, "옵션2.검정");
  assert.match(original.name.restorationPath!, /COST_UNIT_ONLY/);
  const changed = normalizeNaverSalesDay(request(), input({ rows: [{ ...source, canonicalSalesUnitId: "replacement-unit" }],
    signatures, salesUnits: [unit({ id: "replacement-unit" })], costSettings: [manual({ canonicalSalesUnitId: "replacement-unit" })] })).sales[0];
  assert.equal(changed.productName, original.productName); assert.equal(changed.productCost, original.productCost);
  assert.equal(changed.name.nameInputHash, original.name.nameInputHash, "same restored name is independent of source IDs");
  const renamed = normalizeNaverSalesDay(request(), input({ rows: [{ ...source, rawProductName: "플로우라이트" }] })).sales[0];
  assert.equal(renamed.productName, "플로우라이트"); assert.equal(renamed.productCost, null);
  assert.equal(renamed.name.restorationPath, null, "an old reference cannot overwrite a different classified product");
  const duplicateName = normalizeNaverSalesDay(request(), input({ rows: [source], signatures, salesUnits: [unit(), unit({ id: "duplicate-name" })] })).sales[0];
  assert.equal(duplicateName.productCost, null, "a reference does not resolve ambiguous same-name cost histories by ID");
});

test("Naver retained internal reference never classifies a new explicit unknown or ambiguous source name", () => {
  const unknown = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: "재등록된 새 미확정 제품" })] })).sales[0];
  assert.equal(unknown.productName, null); assert.equal(unknown.productCost, null);
  assert.equal(unknown.name.matchStatus, "UNMATCHED"); assert.equal(unknown.name.restorationPath, null);
  const base = input({ rows: [row({ rawProductName: "동명 제품" })] });
  base.configuration = { ...base.configuration, nameRules: ["버닝웨이브바", "플로우라이트"].map((canonicalProductName, index) => ({
    id: `collision-${index}`, canonicalProductName, matchType: "EXACT", terms: ["동명 제품"], validFrom: "2026-01-01" })) };
  const ambiguous = normalizeNaverSalesDay(request(), base).sales[0];
  assert.equal(ambiguous.productName, null); assert.equal(ambiguous.productCost, null);
  assert.equal(ambiguous.name.matchStatus, "AMBIGUOUS"); assert.equal(ambiguous.name.restorationPath, null);
  const namedSignature = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, orderSourceSignatureId: "renamed" })],
    signatures: [{ id: "renamed", rawProductNameSnapshot: "플로우라이트", rawOptionInfoSnapshot: null }] })).sales[0];
  assert.equal(namedSignature.productName, "플로우라이트"); assert.equal(namedSignature.productCost, null,
    "a signature that identifies a different product also cannot inherit stale costs");
  const unknownSignature = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, orderSourceSignatureId: "renamed" })],
    signatures: [{ id: "renamed", rawProductNameSnapshot: "완전히새상품", rawOptionInfoSnapshot: null }] })).sales[0];
  assert.equal(unknownSignature.productName, null, "a readable unknown signature never becomes the referenced old product");
});

test("Naver generic option-only unit aliases cannot identify an unrelated unknown product or its cost", () => {
  const sale = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: "완전히새상품", rawOptionInfo: "1+1", canonicalSalesUnitId: null })],
    salesUnits: [unit({ matchAliases: ["1+1"] })] })).sales[0];
  assert.equal(sale.productName, null); assert.equal(sale.productCost, null);
});

test("Naver referenced set name supplements the same classified product and keeps source name evidence", () => {
  const base = input({ rows: [row({ rawProductName: "버닝웨이브바", canonicalSalesUnitId: "set", quantity: "3" })],
    salesUnits: [unit({ id: "set", displayName: "버닝웨이브바 세트" })],
    costSettings: [manual({ canonicalSalesUnitId: "set", unitCost: "3500" })], configuration: {
      products: [{ canonicalName: "버닝웨이브바", requiresSaleUnit: true }], nameRules: [{ id: "set-name", canonicalProductName: "버닝웨이브바",
        matchType: "EXACT", terms: ["버닝웨이브바 세트"], nameField: "sales_unit_name", validFrom: "2026-01-01", validTo: null }]
    } });
  const sale = normalizeNaverSalesDay(request(), base).sales[0];
  assert.equal(sale.productName, "버닝웨이브바"); assert.equal(sale.saleUnitName, "버닝웨이브바 세트");
  assert.equal(sale.productCost, "10500.000000"); assert.equal(sale.name.originalName, "버닝웨이브바");
  assert.equal(sale.name.matchStatus, "MATCHED"); assert.ok(sale.name.ruleIds.includes("set-name"));
});

test("Naver base product in a long title cannot force single cost over a restored specific set name", () => {
  const units = [unit({ id: "flow-group", displayName: "플로우라이트", isGroup: true }),
    unit({ id: "flow-single", displayName: "플로우라이트", parentSalesUnitId: "flow-group", matchAliases: ["단품"] }),
    unit({ id: "flow-set", displayName: "플로우라이트1+1", parentSalesUnitId: "flow-group", matchAliases: ["1+1"] })];
  const base = input({ rows: [row({ rawProductName: "플로우라이트 하체지압 계단오르기 실내 바운스 가정용 홈트 유산소 운동 조이 에어 스텝퍼",
    rawOptionInfo: "⭐️ 컬러선택 ⭐️: 옵션4.블루+블루", canonicalSalesUnitId: "flow-set", quantity: "1" })], salesUnits: units,
    costSettings: [manual({ id: "single", canonicalSalesUnitId: "flow-single", unitCost: "11000" }),
      manual({ id: "set", canonicalSalesUnitId: "flow-set", unitCost: "22000" })] });
  base.configuration = naverConfiguration(request(), date, units, base.configuration);
  const sale = normalizeNaverSalesDay(request(), base).sales[0];
  assert.equal(sale.productName, "플로우라이트"); assert.equal(sale.saleUnitName, "플로우라이트1+1");
  assert.equal(sale.productCost, "22000.000000"); assert.match(sale.name.restorationPath!, /SALE_UNIT_NAME_REFERENCE/);
  const explicitOption = normalizeNaverSalesDay(request(), { ...base, rows: [{ ...base.rows[0], rawOptionInfo: "옵션1.단품" }] }).sales[0];
  assert.equal(explicitOption.saleUnitName, "플로우라이트"); assert.equal(explicitOption.productCost, "11000.000000");
  assert.equal(explicitOption.name.restorationPath, null, "an explicit current unit option takes precedence over a retained reference");
  const explicitTitle = normalizeNaverSalesDay(request(), { ...base, rows: [{ ...base.rows[0], rawProductName: "플로우라이트 단품" }] }).sales[0];
  assert.equal(explicitTitle.saleUnitName, "플로우라이트"); assert.equal(explicitTitle.productCost, "11000.000000");
  const explicitSetOption = normalizeNaverSalesDay(request(), { ...base, rows: [{ ...base.rows[0], canonicalSalesUnitId: "flow-single",
    rawOptionInfo: "옵션5.1+1" }] }).sales[0];
  assert.equal(explicitSetOption.saleUnitName, "플로우라이트1+1"); assert.equal(explicitSetOption.productCost, "22000.000000");
});

test("Naver exact canonical reference restores a missing name only; missing all names keeps revenue unclassified", () => {
  const restored = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null })] })).sales[0];
  assert.equal(restored.productName, "버닝웨이브바"); assert.equal(restored.name.restorationPath, "public.canonical_sales_units.displayName");
  const missing = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, canonicalSalesUnitId: null })] }));
  assert.equal(missing.sales[0].name.matchStatus, "NAME_MISSING"); assert.equal(missing.sales[0].operatingRevenue, "20000.000000");
  assert.equal(missing.sales[0].profitBeforeAds, null); assert.equal(missing.coverage[0].unmatchedAmount, "20000.000000");
});

test("Naver bundled add-on option name identifies the actual item even when its main-product reference is shared", () => {
  const sale = normalizeNaverSalesDay(request(), input({ rows: [row({ rawOptionInfo: "[함께배송⭐추가할인]플로우라이트: 단품" })],
    salesUnits: [unit(), unit({ id: "add-on", displayName: "플로우라이트" })],
    costSettings: [manual(), manual({ id: "add-on-cost", canonicalSalesUnitId: "add-on", unitCost: "500" })] })).sales[0];
  assert.equal(sale.productName, "플로우라이트"); assert.equal(sale.productCost, "1000.000000");
  assert.equal(sale.name.nameField, "rawOptionInfo"); assert.equal(sale.name.restorationPath, "rawOptionInfo.BUNDLED_PRODUCT_NAME");
});

test("Naver sparse names use validated option text or same-store product projection before canonical fallback", () => {
  const option = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, canonicalSalesUnitId: null,
    rawOptionInfo: "플로우라이트: 단품" })], salesUnits: [unit(), unit({ id: "flow", displayName: "플로우라이트" })] })).sales[0];
  assert.equal(option.productName, "플로우라이트"); assert.equal(option.name.restorationPath, "rawOptionInfo.RECOVERED_PRODUCT_NAME");
  const projected = normalizeNaverSalesDay(request(), input({ rows: [row({ rawProductName: null, productNameFallback: "플로우라이트",
    rawOptionInfo: "사이즈: XL" })], salesUnits: [unit(), unit({ id: "flow", displayName: "플로우라이트" })] })).sales[0];
  assert.equal(projected.productName, "플로우라이트"); assert.equal(projected.name.restorationPath, "public.products.productName");
});

test("Naver current non-SALE and other payment dates are excluded, not negative duplicate refunds", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row(), row({ id: "r2", externalProductOrderId: "cancel", saleStatus: "CANCELED" }),
    row({ id: "r3", externalProductOrderId: "return", saleStatus: "RETURNED" }),
    row({ id: "r4", externalProductOrderId: "tomorrow", paymentDate: "2026-10-27" })] }));
  assert.equal(batch.sales.length, 1); assert.equal(batch.sales[0].operatingRevenue, "20000.000000");
  assert.equal(batch.sourceControlTotals[0].excludedByPolicyRows, 3); assert.equal(batch.sourceControlTotals[0].excludedNonSaleAmount, "40000.000000");
});

test("Naver groups preserve VAT once across child order facts, different products and parent aggregates", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row({ productPaymentAmount: "5", quantity: "1" }),
    row({ id: "r2", externalProductOrderId: "o2", productPaymentAmount: "5", quantity: "1", rawProductName: "플로우라이트", canonicalSalesUnitId: "u2" })],
    salesUnits: [unit({ parentSalesUnitId: "parent" }), unit({ id: "u2", displayName: "플로우라이트", parentSalesUnitId: "parent" }),
      unit({ id: "parent", displayName: "부모합계", isGroup: true })],
    costSettings: [manual(), manual({ id: "m2", canonicalSalesUnitId: "u2" })] }));
  assert.equal(batch.sales.length, 2); assert.equal(total(batch.sales.map(s => s.vatExpense)), "1.000000");
  assert.deepEqual(batch.sales.map(s => s.vatExpense), ["1.000000", "0.000000"]);
  assert.equal(batch.sourceControlTotals.find(c => c.measure === "VAT_EXPENSE")!.selectedAmount, "1.000000");
  assert.equal(batch.sales.filter(s => s.productName === "부모합계").length, 0);
});

test("Naver set unit costs multiply order quantity once and never infer physical count from 1+1 spelling", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row({ rawOptionInfo: "1+1", quantity: "3", productPaymentAmount: "60000" })],
    salesUnits: [unit(), unit({ id: "set", displayName: "버닝웨이브바 1+1", matchAliases: ["1+1"] })],
    costSettings: [manual(), manual({ id: "setcost", canonicalSalesUnitId: "set", unitCost: "3500" })] }));
  assert.equal(batch.sales[0].productCost, "10500.000000"); assert.equal(batch.sales[0].calculationQuantity, "3");
  assert.equal(batch.sales[0].saleUnitName, "버닝웨이브바 1+1"); assert.equal(batch.sales[0].physicalQuantity, null);
});

test("Naver API fee presence includes explicit zero and preserves partial-field warning; rate fallback rounds at two decimals", () => {
  const partial = normalizeNaverSalesDay(request(), input({ rows: [row({ paymentCommission: "0", knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null, channelCommission: null })] })).sales[0];
  assert.equal(partial.platformFee, "0.000000"); assert.equal(partial.feePresenceMask, "1000");
  assert.equal(partial.feeBasis, "API_PRESENT_FIELDS_SUM"); assert.ok(partial.quality.issues.includes("API_FEE_PARTIAL_PRESENCE"));
  const fallback = normalizeNaverSalesDay(request(), input({ rows: [row({ paymentCommission: null, knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null, channelCommission: null, productPaymentAmount: "100.05" })] })).sales[0];
  assert.equal(fallback.platformFee, "10.010000"); assert.equal(fallback.feeBasis, "EFFECTIVE_FEE_RATE_FALLBACK");
  const missing = normalizeNaverSalesDay(request(), input({ rows: [row({ paymentCommission: null, knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null, channelCommission: null })], costSettings: [manual({ feeRate: null })] })).sales[0];
  assert.equal(missing.productCost, "4000.000000"); assert.equal(missing.platformFee, null); assert.equal(missing.profitBeforeAds, null);
});

test("Naver latest snapshot omission and expired manual winner never revive old cost; inclusive boundary stays valid", () => {
  const base = input({ costSnapshots: [{ id: "snapshot1", effectiveFrom: "2026-01-01", updatedAt: at },
    { id: "snapshot2", effectiveFrom: date, updatedAt: at }], costSettings: [],
    costEntries: [{ id: "e1", snapshotId: "snapshot1", canonicalSalesUnitId: "unit", unitCost: "1", otherCost: "0", feeRate: "0" }] });
  const omitted = selectNaverCost(date, "unit", base);
  assert.equal(omitted.values, null); assert.ok(omitted.issues.includes("COST_SNAPSHOT_UNIT_OMITTED"));
  const expired = input({ costSnapshots: [{ id: "snapshot", effectiveFrom: "2026-01-01", updatedAt: at }],
    costSettings: [manual({ effectiveFrom: "2026-10-25", effectiveTo: "2026-10-25" })] });
  assert.equal(selectNaverCost(date, "unit", expired).values, null);
  assert.ok(selectNaverCost(date, "unit", expired).issues.includes("COST_SETTING_EXPIRED"));
  assert.notEqual(selectNaverCost("2026-10-25", "unit", expired).values, null);
});

test("Naver snapshot/manual precedence uses effective date then value-update timestamp, not closing timestamp", () => {
  const base = input({ costSnapshots: [{ id: "s", effectiveFrom: date, updatedAt: "2026-10-26T10:00:00+09:00" }],
    costEntries: [{ id: "e", snapshotId: "s", canonicalSalesUnitId: "unit", unitCost: "7", otherCost: "0", feeRate: "0" }],
    costSettings: [manual({ effectiveFrom: date, updatedAt: "2026-10-26T13:00:00+09:00", costValuesUpdatedAt: "2026-10-26T09:00:00+09:00" })] });
  assert.equal(selectNaverCost(date, "unit", base).values!.unitCost, "7");
  base.costSettings = [manual({ effectiveFrom: date, costValuesUpdatedAt: "2026-10-26T10:00:00+09:00" })];
  assert.equal(selectNaverCost(date, "unit", base).values!.unitCost, "2000");
  base.costSettings = [manual({ effectiveFrom: "2026-10-25" })];
  assert.equal(selectNaverCost(date, "unit", base).values!.unitCost, "7");
  base.costSettings = [manual({ effectiveFrom: date, costValuesUpdatedAt: "2026-10-26T09:30:00+09:00" })];
  base.costSnapshots = [{ id: "s", effectiveFrom: date, updatedAt: "2026-10-26T01:00:00.000Z" }];
  assert.equal(selectNaverCost(date, "unit", base).values!.unitCost, "7", "compare timestamps by instant, not lexical offset spelling");
});

test("Naver explicit zero cost stays calculable while absent, invalid and duplicate cost sources stay incomplete", () => {
  const free = normalizeNaverSalesDay(request(), input({ costSettings: [manual({ unitCost: "0", otherCost: "0" })] }));
  assert.equal(free.sales[0].productCost, "0.000000"); assert.notEqual(free.sales[0].profitBeforeAds, null);
  for (const changes of [{ costSettings: [] }, { costSettings: [manual({ unitCost: null })] },
    { costSettings: [manual({ unitCost: "-1" })] }, { costSettings: [manual(), manual({ id: "duplicate" })] }]) {
    const result = normalizeNaverSalesDay(request(), input(changes));
    assert.equal(result.sales[0].productCost, null); assert.equal(result.sales[0].profitBeforeAds, null);
    assert.equal(result.sales[0].operatingRevenue, "20000.000000"); assert.equal(result.coverage[0].missingCostRows, 1);
  }
});

test("Naver malformed row retains its source fact and diagnostics without discarding healthy siblings", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row(), row({ id: "r2", externalProductOrderId: "bad", quantity: null,
    productPaymentAmount: null, paymentCommission: "oops" })] }));
  assert.equal(batch.sales.length, 2); assert.equal(batch.sales[0].operatingRevenue, "20000.000000");
  assert.equal(batch.sales[1].operatingRevenue, null); assert.equal(batch.sales[1].productCost, null); assert.equal(batch.sales[1].platformFee, null);
  assert.ok(batch.sales[1].quality.issues.includes("ORDER_QUANTITY_INVALID"));
  assert.equal(batch.sourceControlTotals[0].selectedAmount, null); assert.equal(batch.sourceControlTotals[0].assignedAmount, "20000.000000");
});

test("Naver empty input requires explicit sync completion and ESTIMATED never changes numerical availability", () => {
  const unknown = normalizeNaverSalesDay(request(), input({ rows: [], complete: false, collectedAt: null }));
  assert.equal(unknown.coverage[0].collectionState, "NOT_COLLECTED"); assert.equal(unknown.coverage[0].zeroConfirmed, false);
  assert.equal(unknown.coverage[0].unmatchedAmount, null);
  assert.ok(unknown.sourceControlTotals.every(control => control.selectedAmount === null && control.assignedAmount === null && control.difference === null));
  const complete = normalizeNaverSalesDay(request(), input({ rows: [] }));
  assert.equal(complete.coverage[0].collectionState, "COMPLETE"); assert.equal(complete.coverage[0].zeroConfirmed, true);
  assert.equal(complete.coverage[0].quality.confidence, "ESTIMATED");
  assert.notEqual(normalizeNaverSalesDay(request(), input()).sales[0].profitBeforeAds, null);
});

test("Naver duplicate product-order identity and excluded-platform work are rejected before transformation", () => {
  assert.throws(() => normalizeNaverSalesDay(request(), input({ rows: [row(), row({ id: "another" })] })), /DUPLICATE_PRODUCT_ORDER/);
  assert.throws(() => normalizeNaverSalesDay({ ...request(), platforms: [] }, input()), /Excluded source/);
  assert.throws(() => normalizeNaverSalesDay(request(), input({ scopeKey: "other-store" })), /SCOPE_DATE/);
});

test("Naver signed operating adjustment preserves Math.round half toward positive infinity VAT", () => {
  const batch = normalizeNaverSalesDay(request(), input({ rows: [row({ productPaymentAmount: "-5", paymentCommission: "0",
    knowledgeShoppingSellingInterlockCommission: "0", saleCommission: "0", channelCommission: "0" })] }));
  assert.equal(batch.sales[0].operatingRevenue, "-5.000000"); assert.equal(batch.sales[0].vatExpense, "0.000000");
  const refundFee = normalizeNaverSalesDay(request(), input({ rows: [row({ paymentCommission: "-50", knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null, channelCommission: null })] })).sales[0];
  assert.equal(refundFee.platformFee, "-50.000000");
  const fallback = normalizeNaverSalesDay(request(), input({ rows: [row({ productPaymentAmount: "-100.05", paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null, saleCommission: null, channelCommission: null })] })).sales[0];
  assert.equal(fallback.platformFee, "-10.000000");
});
