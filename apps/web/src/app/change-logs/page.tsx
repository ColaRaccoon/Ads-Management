"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Save, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";

const CREATIVE_ACTION_TYPES = [
  "NOTE",
  "KEEP",
  "WATCH",
  "SCALE",
  "REDUCE",
  "TURN_ON",
  "TURN_OFF",
  "CREATIVE_TEST",
  "CREATIVE_EXCLUDE",
  "OTHER"
] as const;

type CreativeActionType = (typeof CREATIVE_ACTION_TYPES)[number];

type CreativeListItem = {
  id: string;
  creativeKey: string;
  displayName: string;
  productName: string | null;
  materialNo: string | null;
  firstSeenOn: string | null;
  lastSeenOn: string | null;
  aliasCount: number;
  placementCount: number;
  activePlacementCount: number;
  settings: string[];
  originalNames: string[];
  latestMetrics: {
    metricDate: string | null;
    spendUsd: number;
    purchaseCount: number;
    impressions: number;
    linkClicks: number;
    landingPageViews: number;
    statuses: string[];
  };
  latestLog: {
    actionDate: string;
    actionType: string;
    reason: string;
  } | null;
};

type CreativeDetail = {
  creative: {
    id: string;
    creativeKey: string;
    displayName: string;
    productName: string | null;
    materialNo: string | null;
    firstSeenOn: string | null;
    lastSeenOn: string | null;
  };
  aliases: Array<{
    originalName: string;
    dateCode: string | null;
    setting: string | null;
    parseStatus: string;
    firstSeenOn: string | null;
    lastSeenOn: string | null;
  }>;
  placements: Array<{
    campaignName: string;
    metaCampaignId: string;
    adsetName: string;
    metaAdsetId: string;
    originalAdNames: string[];
    settings: string[];
    firstSeenOn: string | null;
    lastSeenOn: string | null;
    lastStatus: string | null;
  }>;
  dailyMetrics: Array<{
    metricDate: string;
    spendUsd: number;
    purchaseCount: number;
    impressions: number;
    linkClicks: number;
    landingPageViews: number;
    statuses: string[];
  }>;
  logs: Array<{
    id: string;
    actionDate: string;
    actionType: string;
    reason: string;
    memo: string | null;
    relatedAdsetIds: string[];
    nextCheckDate: string | null;
    createdAt: string;
  }>;
};

export default function ChangeLogsPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const [selectedCreativeId, setSelectedCreativeId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionType, setActionType] = useState<CreativeActionType>("NOTE");
  const [actionDate, setActionDate] = useState(todayInputValue());
  const [nextCheckDate, setNextCheckDate] = useState("");
  const [reason, setReason] = useState("");
  const [memo, setMemo] = useState("");
  const [relatedAdsetIds, setRelatedAdsetIds] = useState<Set<string>>(new Set());

  const creatives = useQuery({
    queryKey: ["creative-change-log-list", range],
    queryFn: () => apiGet<CreativeListItem[]>(`/change-logs/creatives?${rangeQuery(range)}`)
  });
  const detail = useQuery({
    queryKey: ["creative-change-log-detail", selectedCreativeId, range],
    enabled: Boolean(selectedCreativeId),
    queryFn: () => {
      if (!selectedCreativeId) {
        throw new Error("creativeId is required");
      }
      return apiGet<CreativeDetail>(`/change-logs/creatives/${selectedCreativeId}?${rangeQuery(range)}`);
    }
  });
  const createLog = useMutation({
    mutationFn: (body: {
      actionDate: string;
      actionType: CreativeActionType;
      reason: string;
      memo?: string;
      relatedAdsetIds: string[];
      nextCheckDate?: string;
    }) => {
      if (!selectedCreativeId) {
        throw new Error("creativeId is required");
      }
      return apiPost(`/change-logs/creatives/${selectedCreativeId}/logs`, body);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creative-change-log-list"] }),
        queryClient.invalidateQueries({ queryKey: ["creative-change-log-detail"] })
      ]);
      setActionType("NOTE");
      setActionDate(todayInputValue());
      setNextCheckDate("");
      setReason("");
      setMemo("");
      setRelatedAdsetIds(new Set());
    }
  });

  useEffect(() => {
    const ids = creatives.data?.map((creative) => creative.id) ?? [];
    if (ids.length === 0) {
      setSelectedCreativeId(null);
      return;
    }
    if (!selectedCreativeId || !ids.includes(selectedCreativeId)) {
      setSelectedCreativeId(ids[0]);
    }
  }, [creatives.data, selectedCreativeId]);

  useEffect(() => {
    setRelatedAdsetIds(new Set());
  }, [selectedCreativeId]);

  const filteredCreatives = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
      return creatives.data ?? [];
    }
    return (creatives.data ?? []).filter((creative) =>
      [creative.displayName, creative.creativeKey, creative.productName, creative.materialNo, ...creative.originalNames]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    );
  }, [creatives.data, search]);

  const selectedCreative = creatives.data?.find((creative) => creative.id === selectedCreativeId) ?? null;
  const selectedDetail = detail.data ?? null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createLog.mutate({
      actionDate,
      actionType,
      reason,
      memo: memo.trim() ? memo.trim() : undefined,
      relatedAdsetIds: Array.from(relatedAdsetIds),
      nextCheckDate: nextCheckDate || undefined
    });
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Change Logs</h1>
          <p>광고소재별 발견일, 사용 세트, 성과, 운영 기록을 확인합니다.</p>
        </div>
      </div>

      <div className="creative-log-layout">
        <aside className="panel creative-list-panel">
          <div className="creative-list-heading">
            <h2>광고소재</h2>
            <span>{creatives.data?.length ?? 0}개</span>
          </div>
          <label className="creative-search">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="소재명 검색" />
          </label>
          <div className="creative-list">
            {filteredCreatives.map((creative) => (
              <button
                key={creative.id}
                className={`creative-item ${creative.id === selectedCreativeId ? "active" : ""}`}
                type="button"
                onClick={() => setSelectedCreativeId(creative.id)}
              >
                <span className="creative-item-title">
                  <strong>{creative.displayName}</strong>
                  <span>{creative.activePlacementCount}/{creative.placementCount}</span>
                </span>
                <span className="creative-item-meta">
                  원본 {creative.aliasCount}개 / 세팅 {creative.settings.length > 0 ? creative.settings.join(", ") : "없음"} / 최근 {formatDate(creative.lastSeenOn)}
                </span>
                <span className="creative-item-stats">
                  <span>{formatUsd(creative.latestMetrics.spendUsd)}</span>
                  <span>구매 {formatNumber(creative.latestMetrics.purchaseCount)}</span>
                  <span>클릭 {formatNumber(creative.latestMetrics.linkClicks)}</span>
                </span>
                <span className="creative-item-log">
                  {creative.latestLog
                    ? `${creative.latestLog.actionDate} ${creative.latestLog.actionType} - ${creative.latestLog.reason}`
                    : "최근 기록 없음"}
                </span>
              </button>
            ))}
            {!creatives.isLoading && filteredCreatives.length === 0 ? <p className="muted">표시할 광고소재가 없습니다.</p> : null}
          </div>
        </aside>

        <section className="panel creative-detail-panel">
          {selectedCreative && selectedDetail ? (
            <div className="creative-detail">
              <div className="creative-detail-header">
                <div>
                  <h2>{selectedDetail.creative.displayName}</h2>
                  <p className="muted">
                    최초 {formatDate(selectedDetail.creative.firstSeenOn)} / 최근 {formatDate(selectedDetail.creative.lastSeenOn)}
                  </p>
                </div>
                <span className="badge keep">{selectedCreative.placementCount} 세트</span>
              </div>

              <div className="creative-metric-row">
                <MetricBox label="최근 지출" value={formatUsd(selectedCreative.latestMetrics.spendUsd)} />
                <MetricBox label="구매" value={formatNumber(selectedCreative.latestMetrics.purchaseCount)} />
                <MetricBox label="링크 클릭" value={formatNumber(selectedCreative.latestMetrics.linkClicks)} />
                <MetricBox label="LPV" value={formatNumber(selectedCreative.latestMetrics.landingPageViews)} />
              </div>

              <section className="creative-detail-block">
                <h3>원본 광고명</h3>
                <div className="alias-list">
                  {selectedDetail.aliases.map((alias) => (
                    <span key={`${alias.originalName}:${alias.setting ?? ""}`} className="alias-chip">
                      {alias.originalName}
                      {alias.setting ? ` / ${alias.setting}` : ""}
                    </span>
                  ))}
                </div>
              </section>

              <section className="creative-detail-block">
                <h3>사용 세트</h3>
                <div className="placement-list">
                  {selectedDetail.placements.map((placement) => (
                    <div key={`${placement.metaCampaignId}:${placement.metaAdsetId}`} className="placement-row">
                      <div>
                        <strong>{placement.adsetName}</strong>
                        <p className="muted">{placement.campaignName}</p>
                        <p className="muted">{placement.originalAdNames.join(", ")}</p>
                      </div>
                      <div className="placement-side">
                        <span className={`status-pill ${placement.lastStatus?.toLowerCase() === "active" ? "active" : ""}`}>
                          {placement.lastStatus ?? "-"}
                        </span>
                        <span>{formatDate(placement.firstSeenOn)} ~ {formatDate(placement.lastSeenOn)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="creative-detail-block">
                <h3>날짜별 성과</h3>
                <div className="metric-table-wrap">
                  <table className="metric-table">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>지출</th>
                        <th>구매</th>
                        <th>노출</th>
                        <th>클릭</th>
                        <th>LPV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedDetail.dailyMetrics.map((metric) => (
                        <tr key={metric.metricDate}>
                          <td>{metric.metricDate}</td>
                          <td>{formatUsd(metric.spendUsd)}</td>
                          <td>{formatNumber(metric.purchaseCount)}</td>
                          <td>{formatNumber(metric.impressions)}</td>
                          <td>{formatNumber(metric.linkClicks)}</td>
                          <td>{formatNumber(metric.landingPageViews)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedDetail.dailyMetrics.length === 0 ? <p className="muted">선택 기간 성과가 없습니다.</p> : null}
                </div>
              </section>

              <section className="creative-detail-block">
                <h3>변경 기록</h3>
                <div className="timeline">
                  {selectedDetail.logs.map((log) => (
                    <article key={log.id} className="timeline-item">
                      <div className="timeline-title">
                        <strong>{log.actionType}</strong>
                        <span>{log.actionDate}</span>
                      </div>
                      <p>{log.reason}</p>
                      {log.memo ? <p className="muted">{log.memo}</p> : null}
                      {log.nextCheckDate ? <small>다음 확인 {log.nextCheckDate}</small> : null}
                    </article>
                  ))}
                  {selectedDetail.logs.length === 0 ? <p className="muted">기록된 로그가 없습니다.</p> : null}
                </div>
              </section>

              <form className="creative-log-form" onSubmit={submit}>
                <h3>새 기록</h3>
                <div className="action-segments">
                  {CREATIVE_ACTION_TYPES.map((type) => (
                    <button
                      key={type}
                      className={`button action-segment ${actionType === type ? "active" : ""}`}
                      type="button"
                      onClick={() => setActionType(type)}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                <div className="creative-form-grid">
                  <label className="field">
                    <span className="field-label">기록일</span>
                    <input className="input" type="date" value={actionDate} onChange={(event) => setActionDate(event.target.value)} required />
                  </label>
                  <label className="field">
                    <span className="field-label">다음 확인일</span>
                    <input className="input" type="date" value={nextCheckDate} onChange={(event) => setNextCheckDate(event.target.value)} />
                  </label>
                </div>
                <div className="related-adsets">
                  {selectedDetail.placements.map((placement) => (
                    <label key={placement.metaAdsetId} className="related-adset">
                      <input
                        type="checkbox"
                        checked={relatedAdsetIds.has(placement.metaAdsetId)}
                        onChange={(event) => {
                          const next = new Set(relatedAdsetIds);
                          if (event.target.checked) {
                            next.add(placement.metaAdsetId);
                          } else {
                            next.delete(placement.metaAdsetId);
                          }
                          setRelatedAdsetIds(next);
                        }}
                      />
                      <span>{placement.adsetName}</span>
                    </label>
                  ))}
                </div>
                <textarea
                  className="textarea"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="사유"
                  required
                />
                <textarea className="textarea" value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="메모" />
                <button className="button primary" type="submit" disabled={createLog.isPending || !reason.trim()}>
                  <Save size={16} />
                  저장
                </button>
              </form>
            </div>
          ) : (
            <div className="creative-empty">
              <h2>선택된 광고소재가 없습니다.</h2>
              <p className="muted">Meta 광고 CSV를 업로드하면 광고 이름 규칙에 따라 소재 목록이 생성됩니다.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="creative-metric-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function todayInputValue() {
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  return today.toISOString().slice(0, 10);
}

function formatDate(value: string | null) {
  return value ?? "-";
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}
