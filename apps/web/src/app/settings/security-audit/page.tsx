"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { PermissionPage } from "@/components/permission-page";
import { apiGet } from "@/lib/api";
import { parseAuditResponse } from "@/features/user-management/user-management";

type AuditFilters = {
  action: string;
  actorUserId: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: AuditFilters = { action: "", actorUserId: "", from: "", to: "" };

export default function SecurityAuditPage() {
  return <PermissionPage permission="audit.read"><SecurityAuditContent /></PermissionPage>;
}

function SecurityAuditContent() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const audit = useInfiniteQuery({
    queryKey: ["security", "audit", filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => parseAuditResponse(await apiGet<unknown>(auditPath(filters, pageParam))),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFilters = {
      action: draft.action.trim(),
      actorUserId: draft.actorUserId.trim(),
      from: draft.from,
      to: draft.to
    };
    const error = validateAuditFilters(nextFilters);
    if (error) {
      setFilterError(error);
      return;
    }
    setFilterError(null);
    setFilters(nextFilters);
  }

  return (
    <section className="page security-admin-page">
      <div className="page-title">
        <div>
          <h1>보안 감사</h1>
          <p>사용자 수명주기와 중요 변경의 append-only 감사 결과를 안전한 요약으로 조회합니다.</p>
        </div>
      </div>

      <form className="panel security-audit-filters" onSubmit={applyFilters}>
        <label>
          작업
          <input
            className="input"
            value={draft.action}
            maxLength={100}
            placeholder="예: USER_ROLE_CHANGED"
            onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))}
          />
        </label>
        <label>
          행위자 사용자 ID
          <input
            className="input"
            value={draft.actorUserId}
            maxLength={128}
            onChange={(event) => setDraft((current) => ({ ...current, actorUserId: event.target.value }))}
          />
        </label>
        <label>
          시작일
          <input className="input" type="date" value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
        </label>
        <label>
          종료일
          <input className="input" type="date" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
        </label>
        <div className="toolbar">
          <button className="button primary" type="submit">필터 적용</button>
          <button className="button" type="button" onClick={() => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setFilterError(null); }}>초기화</button>
        </div>
        {filterError ? <div className="auth-error security-filter-error" role="alert">{filterError}</div> : null}
      </form>

      <div className="panel security-audit-panel">
        <div className="security-panel-heading">
          <div>
            <h2>감사 이벤트</h2>
            <p className="muted">비밀번호, 초대 확인 값, 쿠키, provider 원문과 raw JSON은 표시하지 않습니다.</p>
          </div>
          <button className="button" type="button" disabled={audit.isFetching} onClick={() => void audit.refetch()}>
            {audit.isFetching && !audit.isFetchingNextPage ? "새로고침 중…" : "새로고침"}
          </button>
        </div>
        {audit.error ? <div className="auth-error" role="alert">감사 이벤트를 불러오지 못했습니다.</div> : null}
        {audit.isLoading ? <div className="security-empty">감사 이벤트를 불러오는 중입니다.</div> : null}
        {!audit.isLoading && items.length === 0 ? <div className="security-empty">조건에 맞는 감사 이벤트가 없습니다.</div> : null}
        <div className="security-audit-list">
          {items.map((item) => (
            <article className="security-audit-card" key={item.id}>
              <div className="security-audit-heading">
                <strong>{item.action}</strong>
                <span className="security-status-chip">{item.result}</span>
                <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time>
              </div>
              <p>{item.summary}</p>
              <div className="security-audit-meta">
                <span>행위자: {item.actorType}{item.actorUserId ? ` · ${item.actorUserId}` : ""}</span>
                <span>대상: {item.targetType}{item.targetId ? ` · ${item.targetId}` : ""}</span>
                {item.requestId ? <span>요청 ID: {item.requestId}</span> : null}
              </div>
            </article>
          ))}
        </div>
        {audit.hasNextPage ? (
          <button className="button security-load-more" type="button" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {audit.isFetchingNextPage ? "다음 기록 불러오는 중…" : "다음 기록 50개"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function auditPath(filters: AuditFilters, cursor: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (filters.action) params.set("action", filters.action);
  if (filters.actorUserId) params.set("actorUserId", filters.actorUserId);
  if (filters.from) params.set("from", `${filters.from}T00:00:00.000+09:00`);
  if (filters.to) params.set("to", `${filters.to}T23:59:59.999+09:00`);
  if (cursor) params.set("cursor", cursor);
  return `/security-audit?${params.toString()}`;
}

function validateAuditFilters(filters: AuditFilters) {
  if (filters.action && !/^[A-Z][A-Z0-9_]{0,95}$/.test(filters.action)) {
    return "작업 필터는 대문자 영문으로 시작하고 대문자, 숫자, 밑줄만 사용할 수 있습니다.";
  }
  if (filters.actorUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filters.actorUserId)) {
    return "행위자 사용자 ID는 올바른 UUID 형식이어야 합니다.";
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return "시작일은 종료일보다 늦을 수 없습니다.";
  }
  return null;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}
