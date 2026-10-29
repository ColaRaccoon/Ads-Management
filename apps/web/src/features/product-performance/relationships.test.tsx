import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { RelationshipPanel, RelationshipResults, RelationshipTooltip } from "./relationships";
import { assertRelationshipResponse, availableAnalysisMedia, loadRelationships, relationshipCoordinates, relationshipKey, relationshipParams, selectedAnalysisMedia, validChangeDate,
  type Relationships, type RelationshipPair, type RelationshipLag, type RelationshipWindow } from "./relationships-model";
import { testEnvelope, testFilters } from "./test-fixture";
import type { Reader } from "./model";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
const filters = testFilters({ platforms: ["META", "CAFE24"], from: "2026-08-01", to: "2026-10-26" });
function fixture(): Relationships {
  const pair: RelationshipPair = { adDate: "2026-08-01", outcomeDate: "2026-08-15", adSpend: "9007199254740993.000001", outcome: "2100.123456", otherAdSpend: "300.000001", isEstimate: true, issues: [] };
  const lags: RelationshipLag[] = [0, 1, 3, 7, 14].map(lagDays => ({ lagDays, metric: "revenue", from: filters.from, to: filters.to,
    expectedDays: 87, usedDays: 1, excludedDays: 86, excludedDates: [{ outcomeDate: "2026-08-16", adDate: "2026-08-02", reasons: ["MISSING_AD_SPEND"] }],
    pairs: [pair], coefficient: null, reasons: ["INSUFFICIENT_PAIRS", "EXCESSIVE_MISSING"], volatility: { adSpendStdDev: "0.0000000000", outcomeStdDev: "0.0000000000" }, isEstimate: true, issues: [] }));
  return { ...testEnvelope(filters), baseSnapshotHash: "snapshot", analysis: { analysisMedia: ["META"], availableMedia: ["META"], outcomeLabel: "선택 플랫폼 매출",
    lookbackFrom: "2026-07-18", events: { status: "UNAVAILABLE", message: "행사·가격·품절 이력은 연결되어 있지 않습니다." }, policy: { minimumPairs: 60, maximumMissingFraction: "0.2", lagDirection: "AD_BEFORE_OUTCOME", movingAverageUse: "VISUAL_ONLY" },
    lags, daily: [{ date: pair.outcomeDate, weekday: 6, adSpend: pair.adSpend, otherAdSpend: pair.otherAdSpend, revenue: pair.outcome, profitBeforeAds: "1000.000001", isEstimate: true, issues: [], movingAverage7: { adSpend: null, otherAdSpend: null, revenue: null, profitBeforeAds: null } }],
    beforeAfter: [], warnings: ["OBSERVATIONAL_RELATIONSHIP_ONLY"] } };
}

test("analysis media only includes active platforms and never changes the dashboard filters", () => {
  const original = structuredClone(filters);
  assert.deepEqual(availableAnalysisMedia(["CAFE24"]), []);
  assert.deepEqual(selectedAnalysisMedia(["META", "CAFE24"], ["META", "NAVER_DA"]), ["META"]);
  assert.deepEqual(selectedAnalysisMedia(["META"], []), []);
  const params = relationshipParams(filters, ["META", "NAVER_DA"], "2026-09-02");
  assert.equal(params.get("analysisMedia"), '["META"]'); assert.equal(params.get("platforms"), '["META","CAFE24"]');
  assert.equal(params.get("changeDate"), "2026-09-02"); assert.deepEqual(filters, original);
  const anchor = testEnvelope(filters);
  assert.notDeepEqual(relationshipKey("user1", filters, ["META"], "", anchor), relationshipKey("user2", filters, ["META"], "", anchor));
  assert.notDeepEqual(relationshipKey("user1", filters, ["META"], "", anchor), relationshipKey("user1", filters, [], "", anchor));
  assert.notDeepEqual(relationshipKey("user1", filters, ["META"], "", anchor), relationshipKey("user1", filters, ["META"], "2026-09-02", anchor));
  assert.notDeepEqual(relationshipKey("user1", filters, ["META"], "", anchor), relationshipKey("user1", filters, ["META"], "", { ...anchor, snapshotHash: "new" }));
});

test("load rejects mismatched scope, media, change date and base publication without showing old results", async () => {
  const anchor = testEnvelope(filters);
  for (const mutate of [
    (data: Relationships) => { data.selection.productName = "다른 제품"; },
    (data: Relationships) => { data.baseSnapshotHash = "old"; },
    (data: Relationships) => { data.analysis.analysisMedia = ["NAVER_DA"]; },
    (data: Relationships) => { data.selection.selectedPlatforms = ["NAVER"]; },
    (data: Relationships) => { data.analysis.changeDate = "2026-09-02"; },
  ]) {
    const data = fixture(); mutate(data);
    await assert.rejects(loadRelationships(filters, ["META"], "", anchor, (async () => data) as Reader), /조회 조건 또는 발행 버전/);
  }
  let requests = 0;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(loadRelationships(filters, ["META"], "", anchor, (async () => { requests++; return fixture(); }) as Reader, abort.signal));
  assert.equal(requests, 0);
  const active = new AbortController();
  await assert.rejects(loadRelationships(filters, ["META"], "", anchor, (async () => { active.abort(); return fixture(); }) as Reader, active.signal));
  assert.doesNotThrow(() => assertRelationshipResponse(fixture(), filters, ["META"], "", anchor));
});

test("invalid dates and unsafe plotting numbers do not invent coordinates or zero amounts", () => {
  for (const value of ["2026-13-01", "2026-02-30", "2025-10-01", "bad"]) assert.equal(validChangeDate(value, filters), false);
  assert.equal(validChangeDate("", filters), true); assert.equal(validChangeDate("2026-09-03", filters), true);
  const pairs = fixture().analysis.lags[0].pairs;
  assert.equal(relationshipCoordinates(pairs).length, 0);
  assert.equal(relationshipCoordinates([{ ...pairs[0], adSpend: "100.123456" }]).length, 1);
});

test("scatter tooltip and exact table preserve money, direction, contextual media and estimate metadata", () => {
  const data = fixture(), pair = data.analysis.lags[0].pairs[0];
  const tooltip = renderToStaticMarkup(<RelationshipTooltip pair={pair} outcomeLabel="선택 플랫폼 매출" />);
  assert.match(tooltip, /2026-08-01 광고 → 2026-08-15/);
  assert.match(tooltip, /9,007,199,254,740,993\.000001 원/); assert.match(tooltip, /300\.000001 원/);
  const html = renderToStaticMarkup(<RelationshipResults data={data} metric="revenue" lagDays={14} />);
  assert.match(html, /광고일은 결과일보다 14일 전/); assert.match(html, /9,007,199,254,740,993\.000001 원/);
  assert.match(html, /유효 일별 쌍 60개 미만/); assert.match(html, /누락 과다/); assert.match(html, /선택 플랫폼 매출/);
  assert.match(html, /추정 데이터 포함/); assert.match(html, /광고비 미확인/); assert.match(html, /인과효과가 아닙니다/);
  assert.match(html, /독립 표본으로 사용하지 않습니다/); assert.match(html, /행사·가격·품절 이력/);
  assert.doesNotMatch(html, /제품 전체 매출|효과 발생일은|0\.0000000000<\/td><td>1/);
});

test("before-after incomplete windows expose means and excluded counts with no invented change", () => {
  const data = fixture();
  const period: RelationshipWindow = { from: "2026-08-01", to: "2026-08-07", expectedDays: 7,
    metrics: Object.fromEntries(["adSpend", "otherAdSpend", "revenue", "profitBeforeAds"].map(value => [value, { usedDays: 3, excludedDays: 4, mean: "123.123456", complete: false }])) as RelationshipWindow["metrics"] };
  data.analysis.beforeAfter = [{ windowDays: 7, changeDate: "2026-08-08", before: period, after: { ...period, from: "2026-08-08", to: "2026-08-14" },
    changes: Object.fromEntries(["adSpend", "otherAdSpend", "revenue", "profitBeforeAds"].map(value => [value, { change: null, changePct: null, reason: "INCOMPLETE_WINDOW" }])) as Relationships["analysis"]["beforeAfter"][number]["changes"] }];
  const html = renderToStaticMarkup(<RelationshipResults data={data} metric="revenue" lagDays={0} />);
  assert.match(html, /123\.123456 원/); assert.match(html, /부분 창 · 유효일 평균/); assert.match(html, /전 3·4 \/ 후 3·4/);
  assert.match(html, /기간 내 누락 또는 창 일부만 확보/);
});

test("panel does not request an outcome for ad-only or an ad comparison for sale-only selections", () => {
  for (const saleOnly of [false, true]) {
    const f = testFilters({ platforms: saleOnly ? ["CAFE24"] : ["META"] }), anchor = testEnvelope(f);
    anchor.metricAvailability = { ...anchor.metricAvailability, revenue: saleOnly, adSpend: !saleOnly };
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><RelationshipPanel filters={f} identity="reader:data.read" anchor={anchor} onRefresh={() => {}} /></QueryClientProvider>);
    assert.match(html, saleOnly ? /광고 플랫폼을 선택/ : /판매 플랫폼을 선택/);
    assert.doesNotMatch(html, /선택 범위의 일별 관계 분석을 읽고/); assert.match(html, /통계적 보장이 아닙니다/);
    client.clear();
  }
});
