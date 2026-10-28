import test from "node:test";
import assert from "node:assert/strict";
import { readStorefrontSources } from "./storefront-adapters.service";
import type { StorefrontPlatform, StorefrontSourceRequest } from "./storefront-adapters.service";
import { CONTRACT_VERSION } from "../types";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../types";

const request = (platforms: AdapterRequest["platforms"]): AdapterRequest => ({
  contractVersion: CONTRACT_VERSION, runId: "run", readSnapshotId: "snapshot", from: "2026-10-26", to: "2026-10-26",
  scopeKeys: ["scope"], platforms, scopePolicyVersion: "scope-v1", nameRuleVersion: "name-v1",
  saleUnitRuleVersion: "unit-v1", allocationRuleVersion: "allocation-v1", calculationVersion: "calc-v1", fxVersion: "fx-v1",
  sourcePolicySnapshot: {}, sourceWatermarks: {}, cursor: null, limit: 100
});
const batch = (): AdapterBatch => ({ sales: [], adSpends: [], commonExpenses: [], coverage: [], sourceControlTotals: [], nextCursor: null, sourceFingerprint: "test" });
function fixture(fail: StorefrontPlatform[] = []) {
  const calls: StorefrontPlatform[] = [];
  const adapters = Object.fromEntries((["META", "GOOGLE", "CAFE24"] as const).map(platform => [platform, {
    platform, read: async () => { calls.push(platform); if (fail.includes(platform)) throw new Error("private provider details"); return batch(); }
  }])) as unknown as Record<StorefrontPlatform, SourceAdapter>;
  return { calls, adapters };
}
const inputs = (platforms: AdapterRequest["platforms"]): StorefrontSourceRequest[] =>
  (["META", "GOOGLE", "CAFE24"] as const).map(platform => ({ platform, request: request(platforms) }));

test("one source failure preserves both other source batches and sanitizes the error", async () => {
  for (const platform of ["META", "GOOGLE", "CAFE24"] as const) {
    const f = fixture([platform]);
    const results = await readStorefrontSources(inputs(["META", "GOOGLE", "CAFE24"]), f.adapters);
    assert.equal(results.filter(row => row.status === "READ").length, 2);
    assert.deepEqual(results.find(row => row.platform === platform), { platform, scopeKeys: ["scope"], status: "FAILED", batch: null, issue: "SOURCE_READ_FAILED" });
  }
});

test("selection skips excluded adapters without coupling Cafe24 to Google or Meta", async () => {
  const f = fixture(["META", "GOOGLE"]);
  const result = await readStorefrontSources(inputs(["CAFE24"]), f.adapters);
  assert.deepEqual(f.calls, ["CAFE24"]);
  assert.deepEqual(result.map(row => row.status), ["EXCLUDED_BY_USER", "EXCLUDED_BY_USER", "READ"]);
  const empty = fixture();
  assert((await readStorefrontSources(inputs([]), empty.adapters)).every(row => row.status === "EXCLUDED_BY_USER"));
  assert.equal(empty.calls.length, 0);
});

test("duplicate partitions and malformed selected requests fail before source access", async () => {
  const f = fixture();
  const selected = inputs(["META"]);
  await assert.rejects(readStorefrontSources([selected[0], selected[0]], f.adapters), /Duplicate/);
  selected[0].request.limit = 0;
  await assert.rejects(readStorefrontSources(selected, f.adapters), /page limit/);
  assert.equal(f.calls.length, 0);
});
