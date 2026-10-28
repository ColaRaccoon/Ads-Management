"use client";

import Link from "next/link";
import { useState } from "react";
import { decimal, label, money, time } from "./model";
import type { Coverage, DashboardData, Diagnostic } from "./types";

const nonzero = (value: string | null) => value === null || !/^-?0+(?:\.0+)?$/.test(value);
const problem = (row: Coverage) => row.participation === "INCLUDED" && (row.collectionState !== "COMPLETE" || row.unmappedRows > 0 || row.missingCostRows > 0 ||
  nonzero(row.unallocatedAmount ?? "0") || nonzero(row.missingFxAmount ?? "0") || row.issues.some(issue => !issue.includes("ESTIMATED")));
function missingFxDisplay(row: Diagnostic) {
  if (row.missingFxAmount === null) return "—";
  const currencies = [...new Set(row.controlTotals.map(c => c.currency).filter(Boolean))];
  return currencies.length === 1 ? money(row.missingFxAmount, currencies[0]) : `${decimal(row.missingFxAmount)} (원천통화)`;
}

/** SALE and inherited DIRECT_COST can report the same missing rows; count each source/day once. */
export function diagnosticCounts(rows: Coverage[]) {
  const partitions = new Map<string, Coverage[]>();
  for (const row of rows.filter(row => row.participation === "INCLUDED")) {
    const key = JSON.stringify([row.platform, row.scopeKey, row.date]);
    partitions.set(key, [...(partitions.get(key) ?? []), row]);
  }
  return {
    missingCost: [...partitions.values()].reduce((sum, own) => sum + Math.max(...own.map(row => row.missingCostRows)), 0),
    unmapped: [...partitions.values()].reduce((sum, own) => sum + own.filter(row => row.component !== "DIRECT_COST").reduce((count, row) => count + row.unmappedRows, 0), 0),
    missingDates: [...new Set(rows.filter(row => row.participation === "INCLUDED" && row.collectionState === "NOT_COLLECTED").map(row => row.date))].sort(),
    stale: [...partitions.values()].filter(own => own.some(row => row.collectionState === "STALE")).length
  };
}

function SourceUpdates({ data }: { data: DashboardData }) {
  const { summary } = data;
  const groups = new Map<string, typeof summary.asOfBySource>();
  for (const row of summary.asOfBySource.filter(row => row.date >= summary.selection.from && row.date <= summary.selection.to)) {
    const key = JSON.stringify([row.platform, row.scopeKey]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return <div className="table-wrap"><table><thead><tr><th>원천 / 계정·스토어</th><th>가장 오래된 입력 기준시각 (한국시간)</th><th>마지막 집계 발행 (한국시간)</th><th>발행 일수</th><th>상태</th></tr></thead><tbody>{[...groups].map(([key, rows]) => {
    const sourceTimes = rows.map(row => row.sourceAsOf).filter((value): value is string => value !== null).sort();
    const publishTimes = rows.map(row => row.publishedAt).filter((value): value is string => value !== null).sort();
    return <tr key={key}><td>{label(rows[0].platform)} / {rows[0].scopeKey}</td><td>{time(sourceTimes[0] ?? null)}{rows.some(row => !row.sourceAsOf) ? " · 일부 기준시각 미확인" : ""}</td>
      <td>{time(publishTimes[publishTimes.length - 1] ?? null)}</td><td>{new Set(rows.map(row => row.date)).size}일</td><td>{rows.some(row => row.stale) ? "이전 발행 자료 · 갱신 확인 필요" : "발행 자료"}{rows[0].platform === "NAVER" ? " · 추정 데이터" : ""}</td></tr>;
  })}</tbody></table>{groups.size === 0 ? <p>선택 기간의 발행 자료가 없습니다. 기준시각 미확인을 0원 실적으로 해석하지 않습니다.</p> : null}</div>;
}

function Controls({ rows }: { rows: Diagnostic[] }) {
  const controls = new Map<string, Diagnostic>();
  for (const row of rows) if (row.controlTotals.length) controls.set(JSON.stringify([row.platform, row.scopeKey, row.date]), row);
  return <details><summary>원천 금액 보존 대조 ({controls.size}개 원천·계정·날짜)</summary>
    <p>원천 전체의 대조입니다. 미분류·미배분 잔액을 선택 제품 금액으로 간주하지 않습니다.</p>
    <div className="table-wrap" style={{ maxHeight: 360 }}><table><thead><tr><th>날짜 / 원천</th><th>측정값</th><th>선택 원천액</th><th>귀속액</th><th>미분류</th><th>미배분</th><th>대조 차이</th></tr></thead><tbody>{[...controls].flatMap(([key, row]) => row.controlTotals.map((control, index) => <tr key={`${key}:${index}`}>
      <td>{row.date} / {label(row.platform)} / {row.scopeKey}</td><td>{label(control.measure ?? row.component)}</td><td>{money(control.selectedAmount, control.currency)}</td><td>{money(control.assignedAmount, control.currency)}</td><td>{money(control.unmatchedAmount, control.currency)}</td><td>{money(control.unallocatedAmount, control.currency)}</td><td>{money(control.difference, control.currency)}</td>
    </tr>))}</tbody></table></div>
  </details>;
}

export function DiagnosticsPanel({ data }: { data: DashboardData }) {
  const { summary, diagnostics } = data;
  const [showAll, setShowAll] = useState(false);
  const counts = diagnosticCounts(summary.coverage), previous = diagnosticCounts(summary.comparisonCoverage);
  const rows = diagnostics.items.filter(row => showAll || problem(row));
  const versionLabels: Record<string, string> = { calculationVersion: "계산", nameRuleVersion: "이름 규칙", saleUnitRuleVersion: "판매단위·원가", allocationRuleVersion: "배분", scopePolicyVersion: "참여 정책", fxVersion: "환율" };
  return <section id="performance-diagnostics" className="panel" style={{ marginTop: 16 }}>
    <h2>데이터 진단과 계산 기준</h2>
    <div className="warning-strip"><span>원가 미입력 {counts.missingCost}행</span><span>미매핑 {counts.unmapped}행</span><span>수집 누락 {counts.missingDates.length}일</span><span>이전 발행 사용 {counts.stale}개 원천·날짜</span></div>
    {counts.missingDates.length ? <p>수집 누락 날짜: {counts.missingDates.join(", ")}</p> : null}
    <p>비교기간 진단: 원가 미입력 {previous.missingCost}행 · 미매핑 {previous.unmapped}행 · 수집 누락 {previous.missingDates.length}일. 당기가 완전해도 비교기간 누락은 증감률을 확정하지 못할 수 있습니다.</p>
    {summary.provisional ? <p role="status">오늘 이후 날짜를 포함한 잠정 집계입니다.</p> : null}
    {summary.selectedPlatforms.includes("NAVER") ? <p>네이버는 기존 저장 결과·계산 규칙의 추정 데이터를 포함합니다. 정산 확정액이나 모든 과거 반품의 최신화를 보장하지 않습니다. 마지막 입력 시각과 누락·원가 상태를 함께 확인하세요.</p> : null}
    <h3>현재 조회 범위의 미분류·미배분 잔액</h3>
    <p>아래 금액은 선택한 원천 전체의 잔액이며 선택 제품에 귀속된 비용이 아닙니다. 플랫폼을 제외해도 남은 플랫폼에 재배분하지 않습니다.</p>
    <div className="table-wrap"><table><thead><tr><th>미분류 매출</th><th>미분류 광고 전 이익</th><th>미배분 광고비</th><th>미배분 공통비</th><th>미배분 배송수입</th><th>제품 이익 소계</th></tr></thead><tbody><tr>
      <td>{money(summary.scopeBalances.unclassifiedRevenue)}</td><td>{money(summary.scopeBalances.unclassifiedProfitBeforeAds)}</td><td>{money(summary.scopeBalances.unallocatedAdSpend)}</td><td>{money(summary.scopeBalances.unallocatedExpense)}</td><td>{money(summary.scopeBalances.unallocatedShippingIncome)}</td><td>{money(summary.productProfitSubtotal)}</td>
    </tr></tbody></table></div>
    <p><Link href="/products/mappings" prefetch={false}>제품명·판매단위·배분 설정 확인</Link> · 설정 변경 뒤에는 재집계와 발행이 필요합니다.</p>
    <details><summary>미분류·미배분 상세 원천·날짜</summary><div className="table-wrap" style={{ maxHeight: 320 }}><table><thead><tr><th>종류</th><th>날짜</th><th>원천 / 계정·스토어</th><th>잔액</th></tr></thead><tbody>
      {([["미분류 판매", summary.unclassifiedSales], ["미배분 광고", summary.unallocatedAdSpends], ["미배분 비용·배송수입", summary.unallocatedExpenses]] as const).flatMap(([kind, balances]) => balances.map((balance, index) => <tr key={`${kind}:${index}`}><td>{kind}{balance.kind ? ` / ${label(balance.kind)}` : ""}</td><td>{balance.date}</td><td>{label(balance.platform)} / {balance.scopeKey}</td><td>{money(balance.amount)}</td></tr>))}
    </tbody></table></div></details>
    <h3>원천별 마지막 갱신</h3><SourceUpdates data={data} />
    <h3>발행 계산 버전</h3>
    <p>발행 버전과 현재 설정 버전은 다를 수 있습니다. 복수 발행 버전은 MIXED로 표시합니다.</p>
    <div className="table-wrap"><table><thead><tr><th>기준</th><th>발행 결과 버전</th><th>현재 설정 버전</th></tr></thead><tbody>{Object.entries(versionLabels).map(([key, title]) => <tr key={key}><td>{title}</td><td>{summary.versions[key] ?? "발행 없음"}</td><td>{summary.latestConfigurationVersions[key] ?? "별도 기준"}</td></tr>)}</tbody></table></div>
    <p>계약 {summary.contractVersion} · 요청 계산 기준 {summary.requestedCalculationVersion}</p>
    <p>범위 이익 = 광고 전 이익 − 선택 광고비 − 선택 공통비 + 선택 배송수입. 직접비에 포함된 비용은 중복 차감하지 않습니다. 미완전 금액은 확인된 부분 금액으로 표시합니다.</p>
    {summary.warnings.length ? <details open><summary>확인할 사항 ({summary.warnings.length})</summary><ul>{summary.warnings.map(warning => <li key={warning}>{label(warning)} <small>({warning})</small></li>)}</ul></details> : null}
    <h3>구성요소별 수집·비용 상태</h3>
    <p>진단 자료 {diagnostics.items.length} / {diagnostics.total}행 조회 · 현재 조건에 표시한 행 {rows.length}개{diagnostics.items.length < diagnostics.total ? " · 나머지 진단은 다음 페이지에서 확인하세요." : ""}</p>
    <label><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> 정상 구성요소도 표시</label>
    <p>각 행의 원가 누락·미매핑 수는 구성요소 진단이며 중복될 수 있습니다. 상단 원가 누락 합계는 같은 원천·날짜의 상속 진단을 중복 합산하지 않습니다.</p>
    <div className="table-wrap" style={{ maxHeight: 480 }}><table><thead><tr><th>날짜 / 원천</th><th>구성요소</th><th>수집 상태</th><th>행수 / 0원 확인</th><th>원가 누락</th><th>미매핑</th><th>미배분액</th><th>환율 누락 원금액 (원천통화)</th><th>입력 기준시각 (한국시간)</th><th>진단</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.platform}:${row.scopeKey}:${row.date}:${row.component}:${index}`}>
      <td>{row.date} / {label(row.platform)} / {row.scopeKey}</td><td>{label(row.component)}</td><td>{label(row.collectionState)}{row.isEstimate ? " · 추정" : ""}</td><td>{row.rowsPresent} / {row.zeroConfirmed ? "완료된 0원" : "0원 미확인"}</td><td>{row.missingCostRows}</td><td>{row.unmappedRows}</td><td>{money(row.unallocatedAmount)}</td><td>{missingFxDisplay(row)}</td><td>{time(row.sourceAsOf)}</td><td>{row.issues.map(issue => label(issue)).join(" · ") || "없음"}</td>
    </tr>)}</tbody></table>{rows.length === 0 ? <p>현재 필터에 해당하는 진단 행이 없습니다.</p> : null}</div>
    <Controls rows={diagnostics.items} />
  </section>;
}
