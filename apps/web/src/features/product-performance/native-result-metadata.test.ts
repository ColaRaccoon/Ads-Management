import assert from "node:assert/strict";
import test from "node:test";
import { compactNativePublicationText, type NativeSourcePublication } from "./native-result-metadata";

test("compact print timestamps use only the report day and disclose unknown and stale sources", () => {
  const source = (overrides: Partial<NativeSourcePublication>): NativeSourcePublication => ({ platform: "CAFE24", scopeKey: "shop",
    date: "2026-11-02", sourceAsOf: "2026-11-02T02:00:00Z", publishedAt: "2026-11-02T04:00:00Z", stale: false, ...overrides });
  const text = compactNativePublicationText("2026-11-02", [source({}), source({ platform: "NAVER", sourceAsOf: "2026-11-02T01:00:00Z", publishedAt: "2026-11-02T05:00:00Z" }),
    source({ platform: "COUPANG", sourceAsOf: null, publishedAt: null, stale: true }),
    source({ date: "2026-11-01", sourceAsOf: "2026-11-01T00:00:00Z", publishedAt: "2026-11-03T00:00:00Z" })]);
  assert.match(text, /원본 가장 이른 기준 2026-11-02 10:00/);
  assert.match(text, /가장 늦은 통합 발행 2026-11-02 14:00/);
  assert.match(text, /원본 시각 미확인 1개 · 발행 시각 미확인 1개 · 이전 성공 자료 1개/);
  assert.match(text, /최신·수집 완료를 보장하지 않습니다/);
  assert.doesNotMatch(text, /2026-11-01|2026-11-03/);
  assert.match(compactNativePublicationText("2026-11-02", []), /원본 가장 이른 기준 미확인 · 가장 늦은 통합 발행 미확인/);
});
