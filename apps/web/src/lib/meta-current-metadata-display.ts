import type { MetaCurrentAsset, MetaCurrentMetadata, MetaCurrentMetadataObservation } from "@/types/meta";

function assetText(label: string, value: MetaCurrentAsset): string {
  const budget = [value.dailyBudgetRaw !== null ? `일 예산 원문 ${value.dailyBudgetRaw}${value.dailyBudgetSourceUnit ? ` ${value.dailyBudgetSourceUnit}` : ""}` : "",
    value.lifetimeBudgetRaw !== null ? `전체 예산 원문 ${value.lifetimeBudgetRaw}${value.lifetimeBudgetSourceUnit ? ` ${value.lifetimeBudgetSourceUnit}` : ""}` : ""].filter(Boolean).join(", ");
  const times = [value.startTime ? `시작 ${value.startTime}` : "", value.endTime ? `종료 ${value.endTime}` : ""].filter(Boolean).join(", ");
  return `${label} 현재 ${value.effectiveStatus ?? "상태 미제공"}${value.status ? ` (설정 ${value.status})` : ""}` +
    (budget ? ` · ${budget} (USD 계정, 단위 미확정)` : "") + (times ? ` · ${times}` : "");
}
export function formatMetaCurrentMetadata(value?: MetaCurrentMetadata | null, observedAt?: string | null): string {
  if (!value || !observedAt) return "";
  return [value.ad ? assetText("광고", value.ad) : "", assetText("광고세트", value.adset),
    assetText("캠페인", value.campaign), `현재 접근 가능한 자산 관찰 ${observedAt} · 과거 실적일의 상태/예산 아님`,linkClickNote(value,!value.ad),purchaseNote(value,!value.ad)].filter(Boolean).join(" · ");
}
export function formatMetaCurrentCampaign(value?: MetaCurrentMetadata | null, observedAt?: string | null): string {
  if (!value || !observedAt) return "";
  return [assetText("캠페인", value.campaign),`현재 접근 가능한 자산 관찰 ${observedAt} · 과거 실적일의 상태/예산 아님`,linkClickNote(value,true),purchaseNote(value,true)].filter(Boolean).join(" · ");
}
function linkClickNote(value:MetaCurrentMetadata,aggregate:boolean):string{
 const context=value.sourceContext,evidence=context?.measurementEvidence;
 if(!evidence||evidence.derivedZeroAdCount===0)return "";
 if(evidence.linkClickBasis==="DERIVED_ZERO_RESIDUAL"&&aggregate)
  return `계정·하루 수집 광고 중 ${evidence.derivedZeroAdCount}개 링크 클릭에 계층 합계로 검증한 파생값 포함(원문 미제공) · 동시 스냅샷 미검증`;
 if(context?.linkClickValueBasis==="DERIVED_ZERO_RESIDUAL")return "링크 클릭: 계층 합계로 검증한 파생값(원문 미제공) · 동시 스냅샷 미검증";
 if(context?.linkClickValueBasis==="DERIVED_ZERO_FILTER")return "링크 클릭: 공급자 필터로 검증한 파생값(원문 미제공)";
 return "";
}
export function formatMetaCurrentObservations(values?: MetaCurrentMetadataObservation[]): string {
  return [...new Set((values ?? []).map((row) => formatMetaCurrentMetadata(row.currentMetadata, row.metadataObservedAt)))].join("\n");
}
function purchaseNote(value:MetaCurrentMetadata,aggregate:boolean):string{
 const ctx=value.sourceContext,p=ctx?.purchaseMeasurement;if(!p)return "";
 const basis=aggregate?`계정·하루 수집 광고 중 ${p.derivedZeroAdCount}개 구매 건수는 계층 합계, 구매금액은 구매 사건 없음으로 파생 0(원문 미제공)`:ctx?.rawPurchaseNull?"구매 건수는 계층 합계, 구매금액은 구매 사건 없음으로 파생 0(원문 미제공)":"Meta 구매 건수·금액 원문";
 return `${basis} · 공급자 기본 기여 조건 미검증 · 동시 스냅샷 미검증 · 계정 구매금액 USD ${p.accountPurchaseValueUsd}, 광고 합계 USD ${p.adPurchaseValueUsd}, 차이 USD ${p.parentMinusAdValueUsd}(미배분)`;
}
export function formatMetaProviderPurchases(value?:{providerPurchaseValueUsd?:number|null;providerPurchaseRoas?:number|null;providerPurchaseContext?:string|null}):string{
 if(value?.providerPurchaseContext!=="MCP_PROVIDER_DEFAULT_UNVERIFIED")return "-";
 const money=value.providerPurchaseValueUsd==null?"미제공":`USD ${value.providerPurchaseValueUsd.toFixed(2)}`;
 const roas=value.providerPurchaseRoas==null?"-":`${value.providerPurchaseRoas.toFixed(4)}배`;
 return `${money} · 구매금액/광고비 ROAS(계산) ${roas} · 기본 기여 조건 미검증`;
}
