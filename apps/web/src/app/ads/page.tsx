"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import {
  isMetaAdsSortKey,
  sortMetaCreativeRows,
  type MetaAdsSortDirection,
  type MetaAdsSortKey
} from "@/lib/meta-ads-sort";
import { buildMetaAdsXlsxWorkbook } from "@/lib/meta-ads-xlsx";
import {
  formatMetaDeliveryStatus,
  formatPercent,
  META_VIDEO_RATE_COLUMNS
} from "@/lib/meta-video-display";
import { useRange } from "@/lib/use-range";
import { downloadXlsx } from "@/lib/xlsx";
import type { MetaCreativePerformanceRow } from "@/types/meta";

type SortKey = MetaAdsSortKey;
type SortDirection = MetaAdsSortDirection;
type DeliveryStatusFilter = "active" | "inactive" | "all" | "hasSpend";
type AdsSettings = {
  query: string;
  deliveryStatus: DeliveryStatusFilter;
  sort: { key: SortKey; direction: SortDirection };
};

type SortableColumn = {
  key: SortKey;
  header: string;
  render: (row: MetaCreativePerformanceRow) => ReactNode;
};

const columns: SortableColumn[] = [
  { key: "product", header: "제품", render: (row) => row.productName ?? "-" },
  { key: "material", header: "소재", render: (row) => row.materialNo ?? row.displayName },
  { key: "status", header: "활성상태", render: (row) => formatMetaDeliveryStatus(row.deliveryStatus) },
  { key: "dataDays", header: "집계일수", render: (row) => numberFmt(row.dataDays) },
  { key: "spend", header: "광고비", render: (row) => money(row.totals.spendUsd, "USD") },
  { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals.purchaseCount) },
  { key: "cpa", header: "CPA", render: (row) => money(row.totals.cpaUsd, "USD") },
  { key: "ctr", header: "CTR", render: (row) => formatPercent(row.totals.ctrLinkPct) },
  { key: "cpm", header: "CPM", render: (row) => money(row.totals.cpmUsd, "USD") },
  { key: "reach", header: "도달", render: (row) => numberFmt(row.totals.reach) },
  ...META_VIDEO_RATE_COLUMNS.map((column): SortableColumn => ({
    key: column.key,
    header: column.label,
    render: (row) => formatPercent(row.totals[column.key])
  }))
];

const ADS_SETTINGS_KEY = "meta-ads-performance:ads-settings:v1";
const DEFAULT_ADS_SETTINGS: AdsSettings = {
  query: "",
  deliveryStatus: "active",
  sort: { key: "product", direction: "asc" }
};

export default function AdsPage() {
  const range = useRange();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [query, setQuery] = useState(DEFAULT_ADS_SETTINGS.query);
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatusFilter>(DEFAULT_ADS_SETTINGS.deliveryStatus);
  const [sort, setSort] = useState(DEFAULT_ADS_SETTINGS.sort);
  const apiDeliveryStatus = deliveryStatus === "hasSpend" ? "all" : deliveryStatus;

  useEffect(() => {
    const settings = readAdsSettings();
    setQuery(settings.query);
    setDeliveryStatus(settings.deliveryStatus);
    setSort(settings.sort);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      writeAdsSettings({ query, deliveryStatus, sort });
    }
  }, [deliveryStatus, query, settingsLoaded, sort]);

  const creatives = useQuery({
    queryKey: ["ad-creatives", range, query, deliveryStatus],
    queryFn: () =>
      apiGet<MetaCreativePerformanceRow[]>(
        `/metrics/ads/creatives?${rangeQuery(range, { q: query, deliveryStatus: apiDeliveryStatus })}`
      ),
    enabled: settingsLoaded
  });

  const filteredRows = useMemo(() => filterRows(creatives.data ?? [], deliveryStatus), [creatives.data, deliveryStatus]);
  const rows = useMemo(() => sortMetaCreativeRows(filteredRows, sort.key, sort.direction), [filteredRows, sort]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>광고 소재 성과</h1>
          <p>날짜 · 제품 · 소재명 기준</p>
        </div>
        <div className="toolbar">
          <select
            className="select"
            value={deliveryStatus}
            onChange={(event) => setDeliveryStatus(event.target.value as DeliveryStatusFilter)}
          >
            <option value="active">활성</option>
            <option value="inactive">비활성</option>
            <option value="hasSpend">광고비 존재</option>
            <option value="all">전체</option>
          </select>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="제품명 또는 소재명"
          />
          <button className="button" type="button" onClick={() => downloadAdsExcel(rows, range)} disabled={rows.length === 0}>
            <Download size={15} />
            엑셀 출력
          </button>
        </div>
      </div>

      {creatives.isError ? (
        <div className="warning-strip">
          <span>API 연결 또는 DB 설정을 확인해주세요.</span>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>
                  <SortableHeader
                    activeDirection={sort.key === column.key ? sort.direction : null}
                    label={column.header}
                    onSort={(direction) => setSort({ key: column.key, direction })}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>조건에 맞는 소재 성과가 없습니다.</td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={`${row.productName ?? "-"}:${row.materialNo ?? row.displayName}:${rowIndex}`}>
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortableHeader({
  activeDirection,
  label,
  onSort
}: {
  activeDirection: SortDirection | null;
  label: string;
  onSort: (direction: SortDirection) => void;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span>{label}</span>
      <span style={{ display: "inline-flex", gap: 2 }}>
        <button
          className="icon-button"
          type="button"
          title={`${label} 오름차순`}
          onClick={() => onSort("asc")}
          style={sortButtonStyle(activeDirection === "asc")}
        >
          <ArrowUp size={13} />
        </button>
        <button
          className="icon-button"
          type="button"
          title={`${label} 내림차순`}
          onClick={() => onSort("desc")}
          style={sortButtonStyle(activeDirection === "desc")}
        >
          <ArrowDown size={13} />
        </button>
      </span>
    </div>
  );
}

function sortButtonStyle(active: boolean) {
  return {
    width: 24,
    height: 24,
    minHeight: 24,
    borderColor: active ? "var(--brand)" : "var(--line-strong)",
    background: active ? "var(--brand-weak)" : "#fff",
    color: active ? "var(--brand)" : "var(--text)"
  };
}

function filterRows(rows: MetaCreativePerformanceRow[], deliveryStatus: DeliveryStatusFilter) {
  return deliveryStatus === "hasSpend" ? rows.filter((row) => row.totals.spendUsd > 0) : rows;
}

function readAdsSettings(): AdsSettings {
  if (typeof window === "undefined") return DEFAULT_ADS_SETTINGS;
  try {
    const raw = window.localStorage.getItem(ADS_SETTINGS_KEY);
    if (!raw) return DEFAULT_ADS_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AdsSettings>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : DEFAULT_ADS_SETTINGS.query,
      deliveryStatus: isDeliveryStatus(parsed.deliveryStatus)
        ? parsed.deliveryStatus
        : DEFAULT_ADS_SETTINGS.deliveryStatus,
      sort: parsed.sort && isMetaAdsSortKey(parsed.sort.key) && isSortDirection(parsed.sort.direction)
        ? { key: parsed.sort.key, direction: parsed.sort.direction }
        : DEFAULT_ADS_SETTINGS.sort
    };
  } catch {
    return DEFAULT_ADS_SETTINGS;
  }
}

function writeAdsSettings(settings: AdsSettings) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ADS_SETTINGS_KEY, JSON.stringify(settings));
  }
}

function isDeliveryStatus(value: unknown): value is DeliveryStatusFilter {
  return value === "active" || value === "inactive" || value === "all" || value === "hasSpend";
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function downloadAdsExcel(rows: MetaCreativePerformanceRow[], range: { from: string; to: string }) {
  const datePart = range.from === range.to ? range.from : `${range.from}~${range.to}`;
  downloadXlsx(`${datePart}_메타_소재성과.xlsx`, buildMetaAdsXlsxWorkbook(rows));
}
