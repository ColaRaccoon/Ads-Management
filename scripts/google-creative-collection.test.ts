import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../apps/api/src/daily-sync/google-ads.client";
import { validGoogleCreatives } from "../apps/api/src/domain/google-creative-metrics";
import { GoogleCanonicalWriterService } from "../apps/api/src/daily-sync/google-canonical-writer.service";

const day = "2026-11-03", customerId = "1391592099";
function fixture(fault = "") {
  const queries: string[] = [];
  const base = (id: string) => ({ segments: { date: day }, campaign: { id: "1" }, adGroup: { id: "2", name: "그룹" },
    adGroupAd: { status: "ENABLED", ad: { id, name: `소재 ${id}`, type: "DEMAND_GEN_MULTI_ASSET_AD",
      demandGenMultiAssetAd: { squareMarketingImages: [{ asset: `customers/${customerId}/assets/4` }] } } } });
  const request: typeof fetch = async (_url, options) => {
    const q = JSON.parse(String(options?.body)).query as string; queries.push(q); let results: unknown[] = [];
    if (q.includes("FROM customer LIMIT")) results = [{ customer: { id: customerId, currencyCode: "KRW", timeZone: "Asia/Seoul" } }];
    else if (q.includes("FROM customer")) results = [{ segments: { date: day }, metrics: { costMicros: "3000000" } }];
    else if (q.includes("FROM campaign")) results = [{ segments: { date: day }, campaign: { id: "1", name: "제품", advertisingChannelType: "DEMAND_GEN" }, metrics: { costMicros: "3000000", impressions: "30", clicks: "3" } }];
    else if (q.includes("FROM asset")) results = fault === "missing-asset" ? [] : [{ asset: { resourceName: `customers/${customerId}/assets/4`, id: "4", name: "이미지", type: "IMAGE", imageAsset: { fullSize: { url: "https://example.com/image.png" } } } }];
    else if (q.includes("conversion_action_category")) results = [{ ...base(fault === "orphan-purchase" ? "99" : "3"), segments: { date: day, conversionActionCategory: "PURCHASE" }, metrics: { conversions: 1.25, conversionsValue: 10000 } }];
    else if (q.includes("video_trueview_views")) results = [];
    else results = [{ ...base("3"), metrics: { costMicros: fault === "spend" ? "4000000" : "3000000", impressions: fault === "impressions" ? "29" : "30", clicks: "3" } }];
    if (fault === "duplicate" && q.includes("FROM ad_group_ad") && !q.includes("conversion_action_category") && !q.includes("video_trueview_views")) results.push(results[0]);
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  return { queries, client: new GoogleAdsClient({ getAccessToken: async () => "synthetic" }, request) };
}
test("real client reconciles creatives, retrieves assets and retains fractional purchases and unavailable video", async () => {
  const f = fixture(), snapshot = await f.client.fetchDay({ customerId, day, deadlineAt: Date.now() + 30000 });
  const payload = snapshot.rows[0].creativeMetrics!;
  assert(validGoogleCreatives(payload, snapshot.rows[0]));
  assert.equal(payload.ads[0].purchaseCount, 1.25); assert.equal(payload.ads[0].purchaseValue, 10000);
  assert.equal(payload.ads[0].videoViews, null); assert.equal(payload.ads[0].assets[0].id, "4");
  assert(f.queries.some(q => q.includes("conversion_action_category = 'PURCHASE'")));
});
for (const fault of ["spend", "impressions", "duplicate", "missing-asset", "orphan-purchase"]) {
  test(`incomplete ${fault} data never produces a publishable snapshot`, async () => {
    await assert.rejects(fixture(fault).client.fetchDay({ customerId, day, deadlineAt: Date.now() + 30000 }));
  });
}
test("canonical writer rechecks child totals before opening publication", async () => {
  const snapshot = await fixture().client.fetchDay({ customerId, day, deadlineAt: Date.now() + 30000 });
  snapshot.rows[0].creativeMetrics!.ads[0].costMicros = "1";
  let calls = 0;
  const writer = new GoogleCanonicalWriterService({ publishUnit: async () => { calls++; } } as never);
  await assert.rejects(writer.publish({ runId: "run", connectionId: "connection", generation: 1n, metricDate: new Date(day), policyVersion: 1, snapshot }));
  assert.equal(calls, 0);
});
