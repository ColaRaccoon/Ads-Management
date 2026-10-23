"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { STOREFRONT_QUERY_OPTIONS, storefrontError, storefrontLabel, storefrontTime, storefrontToday } from "@/lib/storefront-display";
import { StorefrontConnection, StorefrontRun } from "@/types/storefront";
import { DataTable } from "./data-table";

export function StorefrontOperations({ connections, canManageImports, canManageSettings, onRefresh }: {
  connections: StorefrontConnection[]; canManageImports: boolean; canManageSettings: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  return <div className="panel" style={{ marginTop: 12 }}>
    <h2>연결·수집 관리</h2>
    <p>Cafe24는 매일 완료된 전일 하루, Google·Meta는 7일마다 직전 완료 7일을 수집합니다. 수집은 화면을 닫아도 예약에 따라 진행됩니다. 이 화면은 자동 새로고침하지 않습니다.</p>
    <p>과거 주문 수정·늦은 광고 성과·누락 날짜는 자동 보정하지 않습니다. 필요하면 완료된 날짜를 하루씩 명시해 수동 실행하고 결과를 확인하세요. 중지는 이후 수집을 막으며 진행 중인 호출을 강제 종료하지 않습니다.</p>
    <ScheduleWarnings />
    {connections.length === 0 ? <p>연결이 아직 설정되지 않았습니다. 연결 담당자에게 확인하세요.</p> : null}
    {!canManageImports ? <p>수동 동기화·실행 이력은 가져오기 관리 권한이 필요합니다.</p> : null}
    {!canManageSettings ? <p>연결 확인·중지/재개는 설정 관리 권한이 필요합니다.</p> : null}
    {connections.map((connection) => <ConnectionOperations key={connection.id} connection={connection}
      canManageImports={canManageImports} canManageSettings={canManageSettings} onRefresh={onRefresh} />)}
  </div>;
}

export function ConnectionOperations({ connection, canManageImports, canManageSettings, onRefresh }: {
  connection: StorefrontConnection; canManageImports: boolean; canManageSettings: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [day, setDay] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionChecking, setConnectionChecking] = useState(false);
  const [connectionCheckError, setConnectionCheckError] = useState<string | null>(null);
  const history = useQuery({
    ...STOREFRONT_QUERY_OPTIONS,
    queryKey: ["storefront-runs", connection.id, historyPage], enabled: canManageImports && showHistory,
    queryFn: () => apiGet<{ items: StorefrontRun[]; nextPage: number | null }>(`/storefront/connections/${connection.id}/runs?page=${historyPage}`)
  });
  const manual = useMutation({
    mutationFn: async () => {
      setMessage(null);
      const run = await apiPost<{ id: string }>("/sync-runs", {
        connectionId: connection.id, fromDate: day, toDate: day, mode: "MANUAL",
        requestKey: `storefront-${crypto.randomUUID()}`, reason: "MANUAL_DAY_RECOVERY"
      });
      return apiPost<{ status: string }>(`/sync-runs/${run.id}/execute-${connection.provider.toLowerCase()}`);
    },
    onSuccess: async (result) => {
      setMessage(`수동 수집: ${storefrontLabel(result.status)}. 최신 상태를 확인하세요.`);
      await onRefresh().catch(() => setMessage("실행 응답을 받았으나 최신 상태 조회에 실패했습니다. 저장된 자료 새로고침으로 확인하세요."));
      if (showHistory) await history.refetch();
    },
    onError: async () => { await onRefresh().catch(() => undefined); }
  });
  const toggle = useMutation({
    mutationFn: () => apiPatch(`/storefront/connections/${connection.id}/enabled`, {
      enabled: !connection.enabled, expectedUpdatedAt: connection.updatedAt
    }),
    onSuccess: async () => { setMessage(connection.enabled ? "이후 수집을 중지했습니다." : "정상 예약의 수집을 재개했습니다. 누락 날짜를 자동 추가하지 않습니다."); await onRefresh().catch(() => undefined); }
  });
  const reconnect = useMutation({
    mutationFn: () => apiPost<{ authorizeUrl: string }>(`/cafe24/connections/${connection.id}/authorize`),
    onSuccess: (result) => {
      const url = result.authorizeUrl;
      if (url) window.location.assign(url);
      else setMessage("재연결 주소를 확인하지 못했습니다. 연결 담당자에게 확인하세요.");
    }
  });
  const pending = manual.isPending || toggle.isPending || reconnect.isPending;
  const today = storefrontToday(connection.timeZone);
  const validDay = today !== null && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today;
  return <article aria-label={`${storefrontLabel(connection.provider)} 연결`} style={{ borderTop: "1px solid #dce3e8", paddingTop: 16, marginTop: 16 }}>
    <h3>{storefrontLabel(connection.provider)} · {connection.displayName}</h3>
    <p>{connection.currencyCode} · {connection.timeZone} · {connection.cadenceDays === 1 ? "매일 전일 1일" : "주간 직전 완료 7일"} · {connection.enabled ? "개별 연결: 수집 사용" : "개별 연결: 수집 중지"} · {storefrontLabel(connection.accessState)}{connection.reconnectRequired ? " · 재연결 필요" : ""}{connection.stale ? " · 오래된 데이터" : ""}</p>
    <p>최근 시도: {storefrontTime(connection.latestAttempt?.at)} · {storefrontLabel(connection.latestAttempt?.status)}<br />최근 성공: {storefrontTime(connection.lastSuccessAt)}<br />연결 유효기간: {storefrontTime(connection.credentialExpiresAt)}</p>
    {connection.latestAttempt?.safeErrorCode ? <p role="status">{storefrontLabel(connection.latestAttempt.safeErrorCode)}</p> : null}
    <p>선택 기간 완료 날짜: {connection.completedDates.length > 0 ? connection.completedDates.join(", ") : "완료 기록 없음"}</p>
    {canManageSettings ? <div className="toolbar">
      <button type="button" className="button" disabled={connectionChecking || pending} onClick={async () => {
        setConnectionChecking(true); setConnectionCheckError(null);
        try { await onRefresh(); setMessage("저장된 연결 상태를 확인했습니다. 공급자 재인증 검사는 수행하지 않았습니다."); }
        catch { setConnectionCheckError("연결 상태를 확인하지 못했습니다."); }
        finally { setConnectionChecking(false); }
      }}>연결 상태 확인</button>
      <button type="button" className="button" disabled={pending} onClick={() => toggle.mutate()}>{connection.enabled ? "수집 중지" : "수집 재개"}</button>
      {connection.provider === "CAFE24" && connection.reconnectRequired ? <button type="button" className="button" disabled={pending} onClick={() => reconnect.mutate()}>Cafe24 재연결</button> : null}
      {connection.provider !== "CAFE24" && connection.reconnectRequired ? <span>새 인증의 확인·등록은 연결 담당자에게 요청하세요.</span> : null}
    </div> : null}
    {canManageImports ? <div className="toolbar" style={{ marginTop: 12, flexWrap: "wrap" }}>
      <label>수동 수집 날짜 <input type="date" className="input" value={day} onChange={(event) => setDay(event.target.value)} aria-label={`${storefrontLabel(connection.provider)} 수동 수집 날짜`} /></label>
      <button type="button" className="button primary" disabled={!validDay || pending || !connection.enabled || connection.reconnectRequired} onClick={() => manual.mutate()}>이 하루 동기화</button>
      <button type="button" className="button" disabled={pending} onClick={() => setShowHistory((value) => !value)}>{showHistory ? "이력 닫기" : "실행 이력"}</button>
      {day && !validDay ? <span role="status">계정 현지시간 기준 완료된 하루를 선택하세요.</span> : null}
      {today === null ? <span role="status">계정 시간대를 확인하기 전에는 수동 수집을 실행할 수 없습니다.</span> : null}
    </div> : null}
    {manual.isPending ? <p role="status">선택한 하루를 처리하고 있습니다. 화면을 다시 열어도 같은 수집을 자동 시작하지 않습니다.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {connectionCheckError ? <p role="alert">{connectionCheckError}</p> : null}
    {[manual.error, toggle.error, reconnect.error].filter(Boolean).map((error, index) => <p role="alert" key={index}>{storefrontError(error)}</p>)}
    {showHistory && canManageImports ? <div style={{ marginTop: 12 }}>
      <h4>최근 실행 이력</h4>
      <button type="button" className="button" disabled={history.isFetching} onClick={() => void history.refetch()}>이력 새로고침</button>
      {history.isLoading ? <p role="status">이력을 읽고 있습니다.</p> : null}
      {history.isError ? <p role="alert">이력을 확인하지 못했습니다.</p> : null}
      <DataTable rows={history.data?.items ?? []} getRowKey={(row) => row.id} columns={[
        { key: "period", header: "수집 범위", render: (row) => `${row.fromDate.slice(0, 10)} ~ ${row.toDate.slice(0, 10)}` },
        { key: "status", header: "결과", render: (row) => storefrontLabel(row.status) },
        { key: "mode", header: "실행 구분", render: (row) => row.trigger === "SCHEDULED" ? "예약" : "수동" },
        { key: "time", header: "시도 / 종료", render: (row) => <>{storefrontTime(row.startedAt ?? row.createdAt)}<br />{storefrontTime(row.finishedAt)}</> },
        { key: "error", header: "확인 사항", render: (row) => row.safeErrorCode ? storefrontLabel(row.safeErrorCode) : "—" }
      ]} />
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button type="button" className="button" disabled={historyPage <= 1 || history.isFetching} onClick={() => setHistoryPage((page) => page - 1)}>이전 페이지</button>
        <span>{historyPage}페이지</span>
        <button type="button" className="button" disabled={!history.data?.nextPage || history.isFetching} onClick={() => setHistoryPage(history.data!.nextPage!)}>다음 페이지</button>
      </div>
    </div> : null}
  </article>;
}

function ScheduleWarnings() {
  const warnings = useQuery({
    ...STOREFRONT_QUERY_OPTIONS, queryKey: ["storefront-schedule-warnings"], enabled: false,
    queryFn: () => apiGet<{
      items: { scheduleKey: string; scheduledFor: string; status: string; missingDates: string[]; warningCode: string }[];
      history: { scheduleKey: string; truncatedEarlierWindows: boolean }[];
      automaticBackfill: false;
    }>("/source-coverage/schedule-warnings")
  });
  return <div style={{ marginBlock: 12 }}>
    <button className="button" type="button" disabled={warnings.isFetching} onClick={() => void warnings.refetch()}>예약 누락 확인</button>
    {warnings.isFetching ? <p role="status">저장된 예약 이력을 확인합니다. 수집을 시작하지 않습니다.</p> : null}
    {warnings.isError ? <p role="alert">예약 이력을 조회하지 못했습니다. 수집 사용 설정을 연결 담당자에게 확인하세요.</p> : null}
    {warnings.data ? <>
      <p role="status">{warnings.data.items.length > 0 ? `확인 필요 예약 ${warnings.data.items.length}건` : "조회 범위 내 예약 누락 없음"} · 누락 날짜 자동 수집 없음</p>
      <DataTable rows={warnings.data.items} getRowKey={(row) => `${row.scheduleKey}:${row.scheduledFor}`} columns={[
        { key: "scheduled", header: "예약 시각 (한국시간)", render: (row) => storefrontTime(row.scheduledFor) },
        { key: "status", header: "결과", render: (row) => storefrontLabel(row.status) },
        { key: "days", header: "누락 날짜", render: (row) => row.missingDates.join(", ") },
        { key: "warning", header: "확인 사항", render: (row) => storefrontLabel(row.warningCode) }
      ]} />
      {warnings.data.history.some((row) => row.truncatedEarlierWindows) ? <p>오래된 예약은 조회 범위 밖입니다. 전 기간 누락이 없다는 뜻이 아닙니다.</p> : null}
    </> : null}
  </div>;
}
