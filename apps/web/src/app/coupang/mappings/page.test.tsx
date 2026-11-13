import test, { after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import { authCoordinator } from "@/features/auth/auth-coordination";
import CoupangMappingsPage from "./page";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());
function render(manage: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = { user: { id: "reviewer" }, can: (permission: string) => permission === "data.read" || manage } as AuthContextValue;
  const result = renderToStaticMarkup(<QueryClientProvider client={client}><AuthContext.Provider value={auth}><CoupangMappingsPage /></AuthContext.Provider></QueryClientProvider>);
  client.clear(); return result;
}
test("manager sees separate source verification and cannot save/apply before reviewing", () => {
  const html = render(true);
  assert.match(html, /기존 정상 매핑까지 전체 검증/);
  assert.match(html, /입력한 규칙의 영향 미리보기/);
  assert.match(html, /disabled=""[^>]*><svg[^]*?검증한 기간의 자동매핑 반영/);
  assert.match(html, /disabled=""[^>]*><svg[^]*?규칙 생성/);
  assert.match(html, /다른 표기·별칭은 같은 상품의 별도 규칙/);
  assert.match(html, /규칙 저장만으로 과거 자료가 변경되지는 않습니다/);
});
test("read-only reviewer can inspect all mappings without save or rematch actions", () => {
  const html = render(false);
  assert.match(html, /기존 정상 매핑까지 전체 검증/); assert.match(html, /원천 비교 실행/);
  assert.doesNotMatch(html, /검증한 기간의 자동매핑 반영|규칙 생성|입력한 규칙의 영향 미리보기/);
});
