import type { Rule, RuleDraft, RuleKind } from "./types";

export function newRule(kind: RuleKind, today: string): RuleDraft {
  return { kind, productId: null, platform: kind === "NAME" ? null : "CAFE24", scopeKey: null,
    validFrom: today, validTo: null, active: true, reason: "",
    payload: kind === "NAME" ? { matchType: "CONTAINS", terms: [], excludeTerms: [] }
      : kind === "SALE_UNIT" ? { saleUnitName: "", quantityBasis: "SALE_UNIT_TOTAL" }
      : kind === "ALLOCATION" ? { method: "UNALLOCATED", component: "SHIPPING_COST", targets: [] }
      : { components: ["SALE", "DIRECT_COST"] } };
}
export function editRule(rule: Rule): RuleDraft {
  return { kind: rule.kind, productId: rule.productId, platform: rule.platform, scopeKey: rule.scopeKey,
    payload: structuredClone(rule.payload), validFrom: rule.validFrom.slice(0, 10), validTo: rule.validTo?.slice(0, 10) ?? null, active: rule.active,
    expectedVersion: rule.version, reason: "" };
}
/** Compare the full draft and all read-only preview inputs, not just the edited rule ID. */
export const previewKey = (value: unknown) => JSON.stringify(value);
export function configurationError(error: unknown): string {
  const value = error as { status?: number; message?: string };
  if (value?.status === 409) return "다른 변경 또는 중복 저장을 감지했습니다. 입력은 보존했습니다. 최신 설정을 불러와 대조한 뒤 다시 미리보기하세요.";
  if (value?.status === 403) return "이 작업의 권한이 없습니다. 입력을 보존했습니다.";
  if (value?.status === 503) return value.message ?? "통합 성과 기능이 비활성 상태이거나 현재 사용할 수 없습니다.";
  if (value?.status === undefined) return "요청 결과를 확인하지 못했습니다. 입력을 보존했습니다. 재저장 전에 최신 설정과 변경 이력을 확인하세요.";
  return value?.message ?? "요청을 처리하지 못했습니다. 입력을 보존했습니다.";
}
