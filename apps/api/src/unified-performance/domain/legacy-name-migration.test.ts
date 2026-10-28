import assert from "node:assert/strict";
import test from "node:test";
import { baselineAliasDrafts, BASELINE_CANONICAL_PRODUCTS, LegacyNameRuleSnapshot, previewLegacyNameMigration, projectCafe24NameRules, projectCoupangNameRules, projectGoogleNameRules, projectMetaNameRules, projectNaverNameRules } from "./legacy-name-migration";
import { NameInput } from "./product-name-resolver";

const sample: NameInput = { originalName: "두줄보호대", nameField: "rawProductNameSnapshot", platform: "NAVER", scopeKey: "observed-store", businessDate: "2026-10-27" };
const legacy: LegacyNameRuleSnapshot = { legacyRuleId: "old-cafe24", canonicalProductName: "두줄무릎보호대", platform: "CAFE24", scopeKey: "shop1", validFrom: "2026-10-01", matchType: "CONTAINS", terms: ["두줄무릎보호대"], optionInclude: ["1+1"], legacyExternalIdConditionCount: 2, legacyPriority: 100 };

test("01 canonical baseline and exact store aliases preview without writes or input mutation", () => {
  const rules = baselineAliasDrafts("observed-store", "2026-01-01");
  const before = JSON.stringify(rules);
  const preview = previewLegacyNameMigration(BASELINE_CANONICAL_PRODUCTS, rules, [sample], "draft-v1");
  assert.equal(preview.writePerformed, false);
  assert.equal(preview.preview[0].result.canonicalProductName, "두줄무릎보호대");
  assert.equal(JSON.stringify(rules), before);
  assert.ok(BASELINE_CANONICAL_PRODUCTS.some(p => p.canonicalName === "버닝웨이브바"));
  assert.ok(!BASELINE_CANONICAL_PRODUCTS.some(p => p.canonicalName === "버닝 웨이브바"));
});

test("legacy ID/priority semantics need review and IDs never become matching conditions", () => {
  const result = previewLegacyNameMigration(BASELINE_CANONICAL_PRODUCTS, [legacy], [{ ...sample, platform: "CAFE24", scopeKey: "shop1", originalName: "신규 두줄무릎보호대 상품", originalOption: "1+1" }], "draft-v1");
  assert.equal(result.requiresReview, true);
  assert.deepEqual(result.issues.map(i => i.code), ["EXTERNAL_ID_CONDITION_REMOVED", "PRIORITY_NOT_PORTED"]);
  assert.equal(result.preview[0].result.matchStatus, "MATCHED");
  assert.equal("legacyExternalIdConditionCount" in result.proposedRules[0], false);
});

test("ID-only, regex, unknown names and conflicting aliases are surfaced", () => {
  const snapshots: LegacyNameRuleSnapshot[] = [
    { ...legacy, terms: [] }, { ...legacy, legacyRuleId: "regex", matchType: "REGEX" },
    { ...legacy, legacyRuleId: "bad-hardcode", canonicalProductName: "쿨토시" }
  ];
  const invalid = previewLegacyNameMigration(BASELINE_CANONICAL_PRODUCTS, snapshots, [], "v1");
  assert.deepEqual(invalid.issues.map(i => i.code), ["NAME_TERMS_MISSING", "UNSUPPORTED_LEGACY_MATCH", "UNKNOWN_CANONICAL_PRODUCT"]);
  assert.equal(invalid.proposedRules.length, 0);
  const alias = baselineAliasDrafts("observed-store", "2026-01-01")[0];
  const collision = previewLegacyNameMigration(BASELINE_CANONICAL_PRODUCTS, [alias, { ...alias, legacyRuleId: "other", canonicalProductName: "한줄보호대" }], [sample], "v1");
  assert.equal(collision.preview[0].result.matchStatus, "AMBIGUOUS");
  assert.ok(collision.issues.some(i => i.code === "PREVIEW_AMBIGUOUS"));
});

test("existing platform rule projections retain alias OR, contains AND, scopes, options and review warnings", () => {
  const base = { id: "existing", canonicalProductName: "두줄무릎보호대", scopeKey: "shop1", validFrom: "2026-10-01" };
  const rows = projectCafe24NameRules([{ ...base, productNameAliases: ["두줄무릎보호대", "두줄보호대"], productNumbers: ["external-reference"], optionIncludeKeywords: ["1+1"] }]);
  assert.equal(rows.length, 2);
  const result = previewLegacyNameMigration(BASELINE_CANONICAL_PRODUCTS, rows, [{ ...sample, platform: "CAFE24", scopeKey: "shop1", originalOption: "1+1" }], "preview-v1");
  assert.equal(result.preview[0].result.matchStatus, "MATCHED");
  assert.ok(result.issues.some(i => i.code === "NORMALIZATION_CHANGED"));
  assert.equal(JSON.stringify(result.proposedRules).includes("external-reference"), false);
  assert.deepEqual(projectCoupangNameRules([{ ...base, includeKeywords: ["두줄", "무릎"], excludeKeywords: ["아동"] }])[0].terms, ["두줄", "무릎"]);
  assert.equal(projectMetaNameRules([{ ...base, matchType: "REGEX", pattern: "두줄.*" }])[0].matchType, "REGEX");
  assert.deepEqual(projectNaverNameRules([{ ...base, displayName: "두줄", matchAliases: ["두줄보호대"], saleUnitName: "단품" }])[0].terms, ["두줄", "두줄보호대"]);
  assert.equal(projectGoogleNameRules([{ ...base, name: "두줄무릎보호대", displayName: "두줄 보호대" }]).length, 2);
});
