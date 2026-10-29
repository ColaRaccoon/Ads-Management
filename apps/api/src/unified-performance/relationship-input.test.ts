import test from "node:test";
import assert from "node:assert/strict";
import { relationshipDays } from "./relationship-input";
import { parseRelationshipQuery } from "./relationship-query";
import { parseReportQuery } from "./report-query";
import { missingCoverage } from "./report.repository";
import type { PublishedReportFact } from "./report-contract";
import type { Platform, SourceCoverage } from "./types";

const from = "2026-10-26";
const request = (platforms: Platform[]) => parseReportQuery({ from, to: from, platforms, productName: "제품A" });
const fact = (platform: Platform, overrides: Partial<PublishedReportFact> = {}): PublishedReportFact => ({ platform, scopeKey: platform, date: from,
  component: platform === "CAFE24" ? "SALE" : "AD_SPEND", factKey: platform, productName: "제품A", saleUnitName: null,
  amountKrw: "10.123456", completeAmountKrw: "10.123456", profitBeforeAds: "5.123456", completeProfitBeforeAds: "5.123456",
  originalAmount: null, currency: "KRW", quantity: null, attribution: "DIRECT", medium: platform === "NAVER" ? "NAVER_DA" : platform,
  marketplace: platform === "CAFE24" ? "CAFE24" : null, commonKind: null, rowsCount: 1,
  quality: { isEstimate: platform === "NAVER", confidence: platform === "NAVER" ? "ESTIMATED" : "SOURCE_REPORTED", issues: [] }, ...overrides });
function fixture(platforms: Platform[]): { facts: PublishedReportFact[]; coverage: SourceCoverage[] } {
  return { facts: platforms.map(platform => fact(platform)), coverage: platforms.flatMap(platform => missingCoverage({ platform, scopeKey: platform, label: platform }, from)
    .map(c => ({ ...c, collectionState: "COMPLETE" as const, rowsPresent: 1, lastSuccessAt: "2026-10-27T00:00:00Z", quality: { ...c.quality, issues: [] } }))) };
}

test("relationship query validates media against inclusion and change dates without changing the base selection", () => {
  const query = request(["META", "GOOGLE", "CAFE24"]), original = JSON.stringify(query);
  assert.deepEqual(parseRelationshipQuery({}, query).analysisMedia, ["META", "GOOGLE"]);
  assert.deepEqual(parseRelationshipQuery({ analysisMedia: '["GOOGLE","GOOGLE"]', changeDate: from }, query).analysisMedia, ["GOOGLE"]);
  assert.deepEqual(parseRelationshipQuery({ analysisMedia: "[]" }, query).analysisMedia, []);
  for (const input of [{ analysisMedia: '["NAVER_DA"]' }, { analysisMedia: '["CAFE24"]' }, { analysisMedia: "broken" },
    { changeDate: "2026-10-25" }, { changeDate: "2026-02-30" }, { cursor: "cursor" }]) assert.throws(() => parseRelationshipQuery(input, query));
  assert.equal(JSON.stringify(query), original);
});
test("target media completeness is independent of missing other ads and missing product cost", () => {
  const query = request(["META", "GOOGLE", "CAFE24"]), scope = fixture(query.platforms);
  scope.coverage.find(c => c.platform === "GOOGLE")!.collectionState = "NOT_COLLECTED";
  scope.facts.find(f => f.platform === "CAFE24")!.completeProfitBeforeAds = null;
  const day = relationshipDays(scope, query, parseRelationshipQuery({ analysisMedia: '["META"]' }, query), from)[0];
  assert.equal(day.adSpend, "10.123456"); assert.equal(day.otherAdSpend, null);
  assert.equal(day.revenue, "10.123456"); assert.equal(day.profitBeforeAds, null);
});
test("estimated Naver is usable and lookback gaps remain null rather than zero", () => {
  const query = request(["META", "NAVER", "CAFE24"]), scope = fixture(query.platforms);
  // This fixture only has Cafe24 sales, and Naver sales coverage explicitly does not apply.
  for (const c of scope.coverage) if (c.platform === "NAVER" && c.component !== "AD_SPEND") c.participation = "NOT_APPLICABLE";
  const days = relationshipDays(scope, query, parseRelationshipQuery({ analysisMedia: '["NAVER_DA"]' }, query), "2026-10-25");
  assert.equal(days[1].adSpend, "10.123456"); assert.equal(days[1].otherAdSpend, "10.123456"); assert.equal(days[1].isEstimate, true);
  assert.equal(days[0].adSpend, null); assert.equal(days[0].revenue, null);
  const off = request(["META", "CAFE24"]), selected = relationshipDays(scope, off, parseRelationshipQuery({}, off), from)[0];
  assert.equal(selected.isEstimate, false); assert.equal(selected.adSpend, "10.123456");
});
test("unclassified target ads cannot masquerade as complete product spend, while a confirmed product zero can", () => {
  const query = request(["META", "CAFE24"]), scope = fixture(query.platforms), settings = parseRelationshipQuery({}, query);
  scope.facts[0].productName = null;
  assert.equal(relationshipDays(scope, query, settings, from)[0].adSpend, null);
  scope.facts = scope.facts.filter(f => f.platform !== "META");
  assert.equal(relationshipDays(scope, query, settings, from)[0].adSpend, "0.000000");
});
test("analysis sum preserves six-place money and no selected media stays unavailable", () => {
  const query = request(["META", "GOOGLE", "CAFE24"]), scope = fixture(query.platforms);
  const both = relationshipDays(scope, query, parseRelationshipQuery({}, query), from)[0];
  assert.equal(both.adSpend, "20.246912"); assert.equal(both.otherAdSpend, "0.000000");
  const empty = relationshipDays(scope, query, parseRelationshipQuery({ analysisMedia: "[]" }, query), from)[0];
  assert.equal(empty.adSpend, null); assert.equal(empty.otherAdSpend, "20.246912");
});
test("a media outside selected accounts or product participation does not invalidate applicable target spend", () => {
  const query = request(["META", "GOOGLE", "CAFE24"]), scope = fixture(query.platforms), settings = parseRelationshipQuery({}, query);
  scope.coverage = scope.coverage.filter(c => c.platform !== "GOOGLE");
  scope.facts = scope.facts.filter(f => f.platform !== "GOOGLE");
  assert.equal(relationshipDays(scope, query, settings, from)[0].adSpend, "10.123456");
  const full = fixture(query.platforms);
  full.coverage.filter(c => c.platform === "GOOGLE").forEach(c => { c.participation = "NOT_APPLICABLE"; });
  // applicable() also filters excluded component facts before invoking relationshipDays.
  full.facts = full.facts.filter(f => f.platform !== "GOOGLE");
  assert.equal(relationshipDays(full, query, settings, from)[0].adSpend, "10.123456");
  const googleOnly = parseRelationshipQuery({ analysisMedia: '["GOOGLE"]' }, query);
  assert.equal(relationshipDays(full, query, googleOnly, from)[0].adSpend, null);
});
