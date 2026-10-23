import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StorefrontSummary } from "@/types/storefront";
import { StorefrontOverview } from "./storefront-overview";
import { StorefrontOperations } from "./storefront-operations";
import { authCoordinator } from "@/features/auth/auth-coordination";

// The existing browser coordinator creates a native Node BroadcastChannel when
// imported by the SSR test. Close that test-process handle after all assertions.
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

const fixture: StorefrontSummary = {
  from: "2026-10-07", to: "2026-10-07", asOf: "2026-10-12T05:00:00Z", complete: false,
  missingSources: ["KAKAO"], missingDates: [], currencyStatus: "INCOMPLETE",
  totals: { revenueKrw: "19999400", knownSpendKrw: "9007199254740993.000001", totalSpendKrw: null, mer: null },
  channels: [
    { provider: "CAFE24", amount: "19999400", currency: "KRW", spendKrw: null, complete: true, state: "COMPLETE_NONZERO", missingDates: [], warningCodes: [] },
    { provider: "GOOGLE", amount: "0", currency: "KRW", spendKrw: "0", complete: true, state: "COMPLETE_ZERO", missingDates: [], warningCodes: [] },
    { provider: "META", amount: "10673.07", currency: "USD", spendKrw: null, complete: false, state: "PARTIAL", missingDates: [], warningCodes: [] },
    { provider: "KAKAO", amount: null, currency: "KRW", spendKrw: null, complete: false, state: "NOT_CONNECTED", missingDates: [], warningCodes: [] }
  ], daily: [], googleCampaigns: [], coverage: [], exchangeRates: [], warningCodes: ["MISSING_EXCHANGE_RATE"],
  connections: [{ id: "00000000-0000-4000-8000-000000000009", provider: "META", displayName: "격리 연결", externalAccountId: "isolated", currencyCode: "USD", timeZone: "Asia/Seoul", accessState: "READY", enabled: true, updatedAt: "2026-10-12T05:00:00Z", credentialExpiresAt: null, reconnectRequired: false, cadenceDays: 7, latestAttempt: { id: "run", status: "FAILED", at: "2026-10-12T06:00:00Z", safeErrorCode: "PROVIDER_UNAVAILABLE" }, lastSuccessAt: "2026-10-12T05:00:00Z", completedDates: ["2026-10-07"], stale: true }]
};

test("overview exposes partial and normal-zero separately while keeping missing totals and MER blank", () => {
  const html = renderToStaticMarkup(<StorefrontOverview data={fixture} />);
  assert.match(html, /정상 수집 · 0/);
  assert.match(html, /부분 수집 \/ 일부 실패/);
  assert.match(html, /카카오/);
  assert.match(html, /미연동/);
  assert.match(html, /총 광고비<\/span><strong>—<\/strong>/);
  assert.match(html, /MER\)<\/span><strong>—<\/strong>/);
  assert.match(html, /9,007,199,254,740,993.000001/);
  assert.match(html, /Google 비용은 공통 미배분 비용/);
  assert.match(html, /Meta·Google의 광고 기여 전환매출은 더하지 않습니다/);
});

function operations(permissions: { imports: boolean; settings: boolean }) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><StorefrontOperations connections={fixture.connections}
    canManageImports={permissions.imports} canManageSettings={permissions.settings} onRefresh={async () => {}} /></QueryClientProvider>);
  client.clear();
  return html;
}

test("read-only users see previous failure and last success but no protected action controls", () => {
  const html = operations({ imports: false, settings: false });
  assert.match(html, /오래된 데이터/);
  assert.match(html, /수집 실패/);
  assert.match(html, /최근 성공/);
  assert.doesNotMatch(html, />이 하루 동기화</);
  assert.doesNotMatch(html, />수집 중지</);
  assert.doesNotMatch(html, />실행 이력</);
  assert.doesNotMatch(html, />연결 상태 확인</);
});

test("import permission does not grant settings actions and requires an explicit completed day", () => {
  const html = operations({ imports: true, settings: false });
  assert.match(html, /disabled="">이 하루 동기화/);
  assert.doesNotMatch(html, />수집 중지</);
  assert.match(html, />실행 이력</);
  assert.doesNotMatch(html, />연결 상태 확인</);
  assert.match(html, /누락 날짜는 자동 보정하지 않습니다/);
});

test("settings permission permits connection controls without granting import or history actions", () => {
  const html = operations({ imports: false, settings: true });
  assert.match(html, />수집 중지</);
  assert.match(html, />연결 상태 확인</);
  assert.doesNotMatch(html, />이 하루 동기화</);
  assert.doesNotMatch(html, />실행 이력</);
});
