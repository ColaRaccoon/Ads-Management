"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiPost, rangeQuery } from "@/lib/api";
import { DataTable } from "./data-table";

type ReviewRow = {
  rowId: string; date: string; sourceName: string; rowNumber: number; targetKind: string;
  productName: string; optionName: string; optionId: string | null; amountKrw: number;
  beforeProductName: string | null; afterProductName: string | null; reason: string; candidates: string[];
  change: string; reviewReasons: string[];
};
export type CoupangMappingReview = {
  previewToken: string | null; draft: boolean; filteredCount: number; offset: number; take: number; hasMore: boolean;
  summary: { totalCount: number; sourceRowCount: number; resolvedCount: number; reassignedCount: number; lostCount: number;
    unchangedCount: number; reviewCount: number; unmatchedAfterCount: number; optionIdentityConflictCount: number };
  amounts: Record<string, { source: number; matchedBefore: number; matchedAfter: number; unmatchedAfter: number; changed: number }>;
  rows: ReviewRow[];
};
const targets: Record<string, string> = { SALES_PRODUCT: "판매", ADS_SPEND_PRODUCT: "광고비", ADS_CONVERSION_PRODUCT: "전환매출", PROMOTION_PRODUCT: "프로모션 가격" };
const reasons: Record<string, string> = { MATCHED: "매칭", NO_MATCH: "조건 일치 없음", EXCLUDED_BY_KEYWORD: "후보 규칙의 제외 키워드",
  AMBIGUOUS_MATCH: "다른 상품 후보 충돌", OPTION_CONFLICT: "옵션 수량 충돌", AD_DISABLED: "광고 반영 꺼짐",
  LOWER_PRIORITY_PRODUCT_CANDIDATE: "우선순위로 가려진 다른 상품 후보", CONFLICTING_OPTION_QUANTITIES: "수량·구성 확인 필요",
  SOURCE_OPTION_IDENTITY_CONFLICT: "같은 옵션번호에 서로 다른 상품 기록: 원천 비교 필요 (자동 변경 없음)",
  DISABLED_MATCHING_RULE: "광고 반영을 끈 일치 규칙도 존재: 광고비 귀속 확인 필요",
  POSITIVE_CONVERSION_WITHOUT_PRODUCT_NAME: "전환상품명 없이 전환금액 존재: 집행상품에서 추정" };
const changes: Record<string, string> = { RESOLVED: "신규 매칭", REASSIGNED: "상품 변경", LOST: "기존 매칭 해제", UNCHANGED: "동일" };
const money = (value: number) => `${Math.round(value).toLocaleString("ko-KR")}원`;
export const mappingReviewKey = (range: { from: string; to: string }, body: unknown) => JSON.stringify({ range, body });

export function CoupangMappingReviewPanel({ range, body = {}, onReviewed, disabled = false }: {
  range: { from: string; to: string }; body?: unknown; disabled?: boolean;
  onReviewed?: (review: CoupangMappingReview, key: string) => void;
}) {
  const [filter, setFilter] = useState("REVIEW"), [target, setTarget] = useState("ALL");
  const key = mappingReviewKey(range, body);
  const review = useMutation({ mutationFn: async ({ offset, reviewFilter, targetKind }: { offset: number; reviewFilter: string; targetKind: string }) => {
    const result = await apiPost<CoupangMappingReview>(`/coupang/mapping-preview?${rangeQuery(range)}&offset=${offset}&take=100&reviewFilter=${reviewFilter}&targetKind=${targetKind}`, body);
    return { result, key, filter: reviewFilter, target: targetKind };
  }, onSuccess: ({ result, key: reviewedKey }) => onReviewed?.(result, reviewedKey) });
  const current = review.data?.key === key && review.data.filter === filter && review.data.target === target ? review.data.result : undefined;
  const run = (offset = 0, reviewFilter = filter, targetKind = target) => review.mutate({ offset, reviewFilter, targetKind });
  return <div className="panel" style={{ marginTop: 12 }}>
    <h2>{(body as { rule?: unknown }).rule ? "입력한 규칙의 영향 미리보기" : "기존 정상 매핑까지 전체 검증"}</h2>
    <p className="field-help">원천 상품명·옵션명과 현재 연결 상품을 다시 비교합니다. 동일 판정도 정답을 보증하지 않으므로 ‘전체’에서 원문을 확인할 수 있습니다. 원천 오류 행은 검증 대상에서 제외됩니다.</p>
    <button className="button" type="button" disabled={disabled || review.isPending} onClick={() => run()}>{review.isPending ? "전체 원천 비교 중…" : "원천 비교 실행"}</button>
    {review.error && <p role="alert">검증 실패: {review.error.message}</p>}
    {review.data && !current && !review.isPending && <p role="status">조건이 변경되었습니다. 다시 검증하세요.</p>}
    {current && <>
      <p role="status">원천 {current.summary.sourceRowCount.toLocaleString()}행 / 판정 {current.summary.totalCount.toLocaleString()}건 · 신규 매칭 {current.summary.resolvedCount} · 상품 변경 {current.summary.reassignedCount} · 매칭 해제 {current.summary.lostCount} · 미해결 {current.summary.unmatchedAfterCount} · 동일 {current.summary.unchangedCount} · 옵션번호 불일치 {current.summary.optionIdentityConflictCount}개</p>
      <p className="field-help">광고비와 전환매출은 별도 금액이며 합산하지 않습니다. 프로모션은 매출이 아닌 가격 합계입니다. 저장 전 미리보기는 선택 기간에 한정됩니다.</p>
      <DataTable rows={Object.entries(current.amounts)} columns={[
        { key: "target", header: "대상", render: ([name]) => targets[name] },
        { key: "source", header: "원천 합계", render: ([, amount]) => money(amount.source) },
        { key: "before", header: "기존 매칭", render: ([, amount]) => money(amount.matchedBefore) },
        { key: "after", header: "변경 후 매칭", render: ([, amount]) => money(amount.matchedAfter) },
        { key: "unmatched", header: "변경 후 미귀속", render: ([, amount]) => money(amount.unmatchedAfter) }
      ]} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <select aria-label="검증 결과 필터" className="select" value={filter} onChange={event => { setFilter(event.target.value); run(0, event.target.value); }}>
          <option value="REVIEW">변경·의심·미해결</option><option value="CHANGED">상품 변경 사항</option><option value="ALL">정상 포함 전체</option>
        </select>
        <select aria-label="검증 대상" className="select" value={target} onChange={event => { setTarget(event.target.value); run(0, filter, event.target.value); }}>
          <option value="ALL">전체 대상</option>{Object.entries(targets).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <DataTable rows={current.rows} getRowKey={row => row.rowId} empty="해당 조건의 검토 항목이 없습니다." columns={[
        { key: "source", header: "출처", render: row => <>{targets[row.targetKind]} · {row.date}<br />{row.sourceName} / {row.rowNumber}행</> },
        { key: "original", header: "원천 상품명 / 옵션명", render: row => <>{row.productName || "(없음)"}<br /><strong>{row.optionName || "(별도 옵션 필드 없음)"}</strong><br /><span className="field-help">옵션번호(추적용): {row.optionId || "-"}</span></> },
        { key: "before", header: "현재 상품", render: row => row.beforeProductName || "미매칭" },
        { key: "after", header: "재판정 상품", render: row => <>{row.afterProductName || "미매칭"}<br />{changes[row.change]}</> },
        { key: "reason", header: "판정 근거 / 후보", render: row => <>{reasons[row.reason] || row.reason}<br />{row.reviewReasons.map(reason => reasons[reason] || reason).join(" · ")}<br />{row.candidates.join(" / ")}</> },
        { key: "amount", header: "원천 금액", render: row => money(row.amountKrw) }
      ]} />
      <div className="toolbar">
        <button className="button" type="button" disabled={review.isPending || current.offset === 0} onClick={() => run(Math.max(0, current.offset - current.take))}>이전</button>
        <span>{current.filteredCount ? current.offset + 1 : 0}–{Math.min(current.offset + current.take, current.filteredCount)} / {current.filteredCount}건</span>
        <button className="button" type="button" disabled={review.isPending || !current.hasMore} onClick={() => run(current.offset + current.take)}>다음</button>
      </div>
    </>}
  </div>;
}
