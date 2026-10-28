import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { UnifiedProduct } from "@prisma/client";
import { affectedConfigurationScope, configurationImpact } from "./management-impact";
import type { RulePreviewInput } from "./management.dto";
import type { ManagementTransaction } from "./management.repository";

const input: RulePreviewInput = { kind: "ALLOCATION", platform: "COUPANG", scopeKey: null, validFrom: "2026-10-01", reason: "test",
  payload: { method: "REVENUE_SHARE", component: "SHIPPING_COST", targets: [{ productName: "A", weight: null }] },
  impactFrom: "2026-10-01", impactTo: "2026-10-02", previewPlatforms: ["COUPANG"] };
const product = { canonicalName: "A" } as UnifiedProduct;
const fact = (runId: string, productName: string, amountKrw: string | null) => ({ runId, payload: { component: "SALE", productName, amountKrw } });
const tx = (rows: unknown[], runs = ["one", "two"]) => ({ unifiedSourcePublication: { findMany: async () => runs.map(runId => ({ runId })) },
  unifiedDailyFact: { findMany: async () => rows } }) as unknown as ManagementTransaction;

test("configuration rebuild scope includes old and new platform/account and preserves wildcard", () => {
  assert.deepEqual(affectedConfigurationScope({ platform: "GOOGLE", scopeKey: "b" }, { platform: "META", scopeKey: "a" }), { platforms: ["GOOGLE", "META"], scopeKeys: ["b", "a"] });
  assert.equal(affectedConfigurationScope({ platform: "META", scopeKey: "a" }, { platform: null, scopeKey: null }).platforms.length, 5);
  assert.deepEqual(affectedConfigurationScope({ platform: "COUPANG", scopeKey: "single" }), { platforms: ["COUPANG"], scopeKeys: ["single"] });
});

test("revenue-share preview checks each source day rather than a positive period sum", async () => {
  const result = await configurationImpact(tx([fact("one", "A", "100"), fact("two", "A", "0")]), input, null, [product]);
  assert.equal(result.publishedRevenue, "100.000000");
  assert.equal(result.zeroDenominator, true);
  assert.equal(result.publishedAdSpend, null);
});

test("target net corrections, negative weights, missing inputs and unrelated sales cannot hide an unusable denominator", async () => {
  for (const rows of [
    [fact("one", "A", "100"), fact("one", "A", "-100")], [fact("one", "A", "-1")],
    [fact("one", "A", null)], [fact("one", "B", "1000")]
  ]) assert.equal((await configurationImpact(tx(rows, ["one"]), input, null, [product])).zeroDenominator, true);
  assert.equal((await configurationImpact(tx([fact("one", "A", "100"), fact("one", "A", "-50")], ["one"]), input, null, [product])).zeroDenominator, false);
});

test("empty preview selection never reads publication data and remains distinct from zero", async () => {
  const noRead = new Proxy({}, { get: () => { throw Error("DB accessed"); } }) as ManagementTransaction;
  await assert.rejects(configurationImpact(noRead, { ...input, previewPlatforms: null as never }, null, [product]),
    (e: unknown) => typeof (e as { getStatus?: unknown })?.getStatus === "function" && (e as { getStatus(): number }).getStatus() === 400);
  const result = await configurationImpact(noRead, { ...input, previewPlatforms: [] }, null, [product]);
  assert.deepEqual(result.selectedPlatforms, []);
  assert.equal(result.excludedPlatforms.length, 5);
  assert.equal(result.publishedRows, 0);
  assert.equal(result.publishedRevenue, null);
  assert.equal(result.basis, "PUBLISHED_SCOPE_REVIEW_TOTALS");
});
