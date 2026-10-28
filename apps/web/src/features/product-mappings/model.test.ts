import test from "node:test";
import assert from "node:assert/strict";
import { configurationError, editRule, newRule, previewKey } from "./model";
import type { Rule } from "./types";

const saved: Rule = {
  id: "rule-1", kind: "SALE_UNIT", productId: "product-1", platform: "CAFE24", scopeKey: "scope-a",
  payload: { saleUnitName: "2개입 세트", quantityBasis: "SALE_UNIT_TOTAL", salePrice: "0", productCost: null,
    optionInclude: ["세트"], unitsPerSaleUnit: "2", otherCost: "0.000001" },
  validFrom: "2026-10-01", validTo: "2026-10-28", active: true, version: 7
};

test("editing preserves the complete sale-unit configuration, explicit zero, null, and CAS version", () => {
  const draft = editRule(saved);
  assert.deepEqual(draft.payload, saved.payload);
  assert.equal(draft.expectedVersion, 7);
  assert.equal(draft.reason, "");
  (draft.payload.optionInclude as string[]).push("새 옵션");
  assert.deepEqual(saved.payload.optionInclude, ["세트"]);
  assert.equal(draft.payload.salePrice, "0");
  assert.equal(draft.payload.productCost, null);
});

test("audit recovery accepts serialized database dates and keeps an open end date", () => {
  const recovered = editRule({ ...saved, validFrom: "2026-10-01T00:00:00.000Z", validTo: "2026-10-28T00:00:00.000Z" });
  assert.equal(recovered.validFrom, "2026-10-01");
  assert.equal(recovered.validTo, "2026-10-28");
  assert.equal(editRule({ ...saved, validTo: null }).validTo, null);
});

test("preview authorization key changes with payload, samples, dates, platform selection and edited version", () => {
  const input = { ...editRule(saved), samples: [{ originalName: "제품", platform: "CAFE24" }], impactFrom: "2026-10-01", impactTo: "2026-10-28", previewPlatforms: ["CAFE24"] };
  const key = previewKey(input);
  for (const changed of [
    { ...input, payload: { ...input.payload, salePrice: "1" } },
    { ...input, samples: [{ originalName: "새 이름", platform: "CAFE24" }] },
    { ...input, impactFrom: "2026-10-02" },
    { ...input, impactTo: "2026-10-27" },
    { ...input, previewPlatforms: [] },
    { ...input, expectedVersion: 8 }
  ]) assert.notEqual(previewKey(changed), key);
});

test("new drafts use independent payloads and do not inherit a saved version", () => {
  const first = newRule("NAME", "2026-10-28"), second = newRule("NAME", "2026-10-28");
  (first.payload.terms as string[]).push("별칭");
  assert.deepEqual(second.payload.terms, []);
  assert.equal(first.expectedVersion, undefined);
  assert.equal(newRule("SALE_UNIT", "2026-10-28").payload.quantityBasis, "SALE_UNIT_TOTAL");
  assert.deepEqual(newRule("ALLOCATION", "2026-10-28").payload.targets, []);
});

test("permission and conflict errors explain input preservation", () => {
  assert.match(configurationError({ status: 403 }), /권한.*입력을 보존/);
  assert.match(configurationError({ status: 409 }), /중복 저장.*입력은 보존.*최신 설정/);
});

test("an unknown network outcome advises checking saved state before another write", () => {
  assert.match(configurationError(new TypeError("Failed to fetch")), /결과를 확인하지 못.*입력을 보존.*재저장 전에.*변경 이력/);
});
