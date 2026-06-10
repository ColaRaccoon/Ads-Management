"use client";

import { useQuery } from "@tanstack/react-query";
import { format, parseISO, subDays } from "date-fns";
import { Printer, Search, Settings2 } from "lucide-react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";

type CreativePerformanceRow = {
  creativeKey: string;
  displayName: string;
  productName: string | null;
  materialNo: string | null;
  deliveryStatus: string | null;
  totals: {
    spendUsd: number;
    spendKrw: number | null;
    purchaseCount: number;
    cpaUsd: number | null;
    cpaKrw: number | null;
    ctrLinkPct: number | null;
    cpmUsd: number | null;
    roas: number | null;
    revenueKrw: number | null;
  };
  dataDays: number;
};

type DeliveryStatusFilter = "active" | "inactive" | "all" | "hasSpend";
type ColumnKey =
  | "creative"
  | "status"
  | "dataDays"
  | "spendUsd"
  | "spendKrw"
  | "purchaseCount"
  | "cpa"
  | "ctr"
  | "cpm"
  | "roas";

type ColumnDefinition = {
  key: ColumnKey;
  label: string;
};

type DailyReportSettings = {
  query: string;
  deliveryStatus: DeliveryStatusFilter;
  visibleColumns: ColumnKey[];
};

type ProductTotals = {
  spendUsd: number;
  spendKrw: number | null;
  purchaseCount: number;
  cpaUsd: number | null;
  cpaKrw: number | null;
  revenueKrw: number | null;
  roas: number | null;
};

type ProductGroup = {
  productName: string;
  rows: CreativePerformanceRow[];
  totals: ProductTotals;
};

type PreviousIndexes = {
  byCreativeKey: Map<string, CreativePerformanceRow>;
  byProductMaterial: Map<string, CreativePerformanceRow>;
  byDisplayName: Map<string, CreativePerformanceRow>;
};

const DAILY_REPORT_COLUMNS: ColumnDefinition[] = [
  { key: "creative", label: "소재" },
  { key: "status", label: "활성상태" },
  { key: "dataDays", label: "집계일수" },
  { key: "spendUsd", label: "광고비 USD" },
  { key: "spendKrw", label: "광고비 KRW" },
  { key: "purchaseCount", label: "구매건수" },
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "cpm", label: "CPM" },
  { key: "roas", label: "ROAS" }
];

const DEFAULT_VISIBLE_COLUMNS = DAILY_REPORT_COLUMNS.map((column) => column.key);
const DAILY_REPORT_SETTINGS_KEY = "meta-ads-performance:daily-report-settings:v1";
const DEFAULT_DAILY_REPORT_SETTINGS: DailyReportSettings = {
  query: "",
  deliveryStatus: "active",
  visibleColumns: DEFAULT_VISIBLE_COLUMNS
};

export default function DailyReportPage() {
  const range = useRange();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [query, setQuery] = useState(DEFAULT_DAILY_REPORT_SETTINGS.query);
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatusFilter>(
    DEFAULT_DAILY_REPORT_SETTINGS.deliveryStatus
  );
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(
    DEFAULT_DAILY_REPORT_SETTINGS.visibleColumns
  );
  const reportDate = range.to;
  const previousDate = format(subDays(parseISO(reportDate), 1), "yyyy-MM-dd");
  const apiDeliveryStatus = deliveryStatus === "hasSpend" ? "all" : deliveryStatus;

  useEffect(() => {
    const settings = readDailyReportSettings();
    setQuery(settings.query);
    setDeliveryStatus(settings.deliveryStatus);
    setVisibleColumns(settings.visibleColumns);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      writeDailyReportSettings({ query, deliveryStatus, visibleColumns });
    }
  }, [deliveryStatus, query, settingsLoaded, visibleColumns]);

  const current = useQuery({
    queryKey: ["daily-report-creatives", reportDate, query, deliveryStatus],
    queryFn: () =>
      apiGet<CreativePerformanceRow[]>(
        `/metrics/ads/creatives?${rangeQuery(
          { from: reportDate, to: reportDate },
          { q: query, deliveryStatus: apiDeliveryStatus }
        )}`
      ),
    enabled: settingsLoaded
  });

  const previous = useQuery({
    queryKey: ["daily-report-creatives-prev", previousDate, query, deliveryStatus],
    queryFn: () =>
      apiGet<CreativePerformanceRow[]>(
        `/metrics/ads/creatives?${rangeQuery(
          { from: previousDate, to: previousDate },
          { q: query, deliveryStatus: apiDeliveryStatus }
        )}`
      ),
    enabled: settingsLoaded
  });

  const filteredRows = useMemo(
    () => filterRows(current.data ?? [], deliveryStatus),
    [current.data, deliveryStatus]
  );
  const productGroups = useMemo(() => groupRowsByProduct(filteredRows), [filteredRows]);
  const reportTotals = useMemo(() => aggregateProductRows(filteredRows), [filteredRows]);
  const previousIndexes = useMemo(() => buildPreviousIndexes(previous.data ?? []), [previous.data]);
  const selectedColumns = useMemo(
    () => DAILY_REPORT_COLUMNS.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns]
  );
  const isLoading = current.isLoading || previous.isLoading || !settingsLoaded;

  return (
    <section className="page daily-report-page">
      <div className="page-title no-print">
        <div>
          <h1>Daily Report</h1>
          <p>보고 기준일: {reportDate}</p>
        </div>
        <DailyReportToolbar
          deliveryStatus={deliveryStatus}
          query={query}
          visibleColumns={visibleColumns}
          onDeliveryStatusChange={setDeliveryStatus}
          onPrint={() => window.print()}
          onQueryChange={setQuery}
          onToggleColumn={(key) => setVisibleColumns((columns) => toggleColumn(columns, key))}
        />
      </div>

      <DailyReportPrintHeader previousDate={previousDate} reportDate={reportDate} />

      {current.isError || previous.isError ? (
        <div className="warning-strip no-print">
          <span>API 연결 또는 DB 설정을 확인해주세요.</span>
        </div>
      ) : null}

      <DailyReportSummary productCount={productGroups.length} totals={reportTotals} />

      {isLoading ? (
        <div className="daily-report-empty">보고 데이터를 불러오는 중입니다.</div>
      ) : productGroups.length === 0 ? (
        <div className="daily-report-empty">조건에 맞는 소재 성과가 없습니다.</div>
      ) : (
        <div className="daily-product-list">
          {productGroups.map((group) => (
            <ProductReportBox
              key={group.productName}
              columns={selectedColumns}
              group={group}
              previousIndexes={previousIndexes}
              reportDate={reportDate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DailyReportToolbar({
  deliveryStatus,
  query,
  visibleColumns,
  onDeliveryStatusChange,
  onPrint,
  onQueryChange,
  onToggleColumn
}: {
  deliveryStatus: DeliveryStatusFilter;
  query: string;
  visibleColumns: ColumnKey[];
  onDeliveryStatusChange: (value: DeliveryStatusFilter) => void;
  onPrint: () => void;
  onQueryChange: (value: string) => void;
  onToggleColumn: (value: ColumnKey) => void;
}) {
  return (
    <div className="daily-report-controls">
      <select
        className="select"
        value={deliveryStatus}
        onChange={(event) => onDeliveryStatusChange(event.target.value as DeliveryStatusFilter)}
      >
        <option value="active">활성</option>
        <option value="inactive">비활성</option>
        <option value="hasSpend">광고비 존재</option>
        <option value="all">전체</option>
      </select>
      <label className="daily-report-search">
        <Search size={15} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="제품명 또는 소재명" />
      </label>
      <div className="daily-column-picker">
        <span>
          <Settings2 size={15} />
          표시 항목
        </span>
        <div className="daily-column-options">
          {DAILY_REPORT_COLUMNS.map((column) => (
            <label key={column.key}>
              <input
                checked={visibleColumns.includes(column.key)}
                type="checkbox"
                onChange={() => onToggleColumn(column.key)}
              />
              {column.label}
            </label>
          ))}
        </div>
      </div>
      <button className="button primary" type="button" onClick={onPrint}>
        <Printer size={15} />
        출력
      </button>
    </div>
  );
}

function DailyReportPrintHeader({ previousDate, reportDate }: { previousDate: string; reportDate: string }) {
  return (
    <header className="daily-report-print-header">
      <div>
        <h1>Daily Report</h1>
        <p>보고 기준일: {reportDate}</p>
      </div>
      <span>전일 기준일: {previousDate}</span>
    </header>
  );
}

function DailyReportSummary({ productCount, totals }: { productCount: number; totals: ProductTotals }) {
  return (
    <div className="daily-report-summary">
      <MetricTile label="제품수" value={`${numberFmt(productCount)}개`} />
      <MetricTile label="총 광고비 USD" value={money(totals.spendUsd, "USD")} />
      <MetricTile label="총 광고비 KRW" value={money(totals.spendKrw, "KRW")} />
      <MetricTile label="총 구매건수" value={numberFmt(totals.purchaseCount)} />
      <MetricTile label="전체 CPA" value={formatCpa(totals)} />
      <MetricTile label="전체 ROAS" value={formatRoas(totals.roas)} />
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="daily-summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProductReportBox({
  columns,
  group,
  previousIndexes,
  reportDate
}: {
  columns: ColumnDefinition[];
  group: ProductGroup;
  previousIndexes: PreviousIndexes;
  reportDate: string;
}) {
  return (
    <article className="daily-product-box">
      <ProductReportHeader group={group} />
      <ProductCreativeTable columns={columns} previousIndexes={previousIndexes} rows={group.rows} />
      <ProductChangeLogSection productName={group.productName} reportDate={reportDate} />
    </article>
  );
}

function ProductReportHeader({ group }: { group: ProductGroup }) {
  return (
    <div className="daily-product-header">
      <div className="daily-product-title">
        <h2>{group.productName}</h2>
        <span>{numberFmt(group.rows.length)}개 소재</span>
      </div>
      <div className="daily-product-stats">
        <ProductStat label="광고비 USD" value={money(group.totals.spendUsd, "USD")} />
        <ProductStat label="광고비 KRW" value={money(group.totals.spendKrw, "KRW")} />
        <ProductStat label="구매" value={numberFmt(group.totals.purchaseCount)} />
        <ProductStat label="CPA" value={formatCpa(group.totals)} />
        <ProductStat label="ROAS" value={formatRoas(group.totals.roas)} />
      </div>
    </div>
  );
}

function ProductStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="daily-product-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProductCreativeTable({
  columns,
  previousIndexes,
  rows
}: {
  columns: ColumnDefinition[];
  previousIndexes: PreviousIndexes;
  rows: CreativePerformanceRow[];
}) {
  return (
    <div className="daily-product-table-wrap">
      <table className="daily-product-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const previous = findPreviousRow(row, previousIndexes);
            return (
              <tr key={row.creativeKey || row.displayName}>
                {columns.map((column) => (
                  <td key={column.key}>{renderColumnValue(column, row, previous)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProductChangeLogSection({ productName, reportDate }: { productName: string; reportDate: string }) {
  return (
    <section className="product-change-log">
      <h3>광고 수정 기록</h3>
      <p>{reportDate} {productName}에 등록된 기록이 없습니다.</p>
    </section>
  );
}

function renderColumnValue(
  column: ColumnDefinition,
  row: CreativePerformanceRow,
  previous: CreativePerformanceRow | null
): ReactNode {
  switch (column.key) {
    case "creative":
      return <CreativeNameCell row={row} />;
    case "status":
      return <span className={`status-pill ${statusClass(row.deliveryStatus)}`}>{formatStatus(row.deliveryStatus)}</span>;
    case "dataDays":
      return numberFmt(row.dataDays);
    case "spendUsd":
      return (
        <MetricWithPrevious
          current={money(row.totals.spendUsd, "USD")}
          previous={previous ? money(previous.totals.spendUsd, "USD") : "-"}
        />
      );
    case "spendKrw":
      return (
        <MetricWithPrevious
          current={money(row.totals.spendKrw, "KRW")}
          previous={previous ? money(previous.totals.spendKrw, "KRW") : "-"}
        />
      );
    case "purchaseCount":
      return (
        <MetricWithPrevious
          current={numberFmt(row.totals.purchaseCount)}
          previous={previous ? numberFmt(previous.totals.purchaseCount) : "-"}
        />
      );
    case "cpa":
      return (
        <MetricWithPrevious
          current={formatCpa(row.totals)}
          previous={previous ? formatCpa(previous.totals) : "-"}
        />
      );
    case "ctr":
      return (
        <MetricWithPrevious
          current={formatPercent(row.totals.ctrLinkPct)}
          previous={previous ? formatPercent(previous.totals.ctrLinkPct) : "-"}
        />
      );
    case "cpm":
      return (
        <MetricWithPrevious
          current={money(row.totals.cpmUsd, "USD")}
          previous={previous ? money(previous.totals.cpmUsd, "USD") : "-"}
        />
      );
    case "roas":
      return (
        <MetricWithPrevious
          current={formatRoas(row.totals.roas)}
          previous={previous ? formatRoas(previous.totals.roas) : "-"}
        />
      );
  }
}

function CreativeNameCell({ row }: { row: CreativePerformanceRow }) {
  return (
    <div className="daily-creative-name">
      <strong>{row.materialNo ?? row.displayName}</strong>
      {row.materialNo ? <span>{row.displayName}</span> : null}
    </div>
  );
}

function MetricWithPrevious({ current, previous }: { current: string; previous: string }) {
  return (
    <span className="metric-with-previous">
      <strong>{current}</strong>
      <small>전일 {previous}</small>
    </span>
  );
}

function filterRows(rows: CreativePerformanceRow[], deliveryStatus: DeliveryStatusFilter) {
  if (deliveryStatus !== "hasSpend") {
    return rows;
  }
  return rows.filter((row) => row.totals.spendUsd > 0);
}

function groupRowsByProduct(rows: CreativePerformanceRow[]): ProductGroup[] {
  const groups = new Map<string, CreativePerformanceRow[]>();
  for (const row of rows) {
    const productName = row.productName?.trim() || "제품명 미파싱";
    groups.set(productName, [...(groups.get(productName) ?? []), row]);
  }

  return Array.from(groups.entries())
    .map(([productName, productRows]) => ({
      productName,
      rows: sortCreativeRows(productRows),
      totals: aggregateProductRows(productRows)
    }))
    .sort((a, b) => {
      const spendDiff = b.totals.spendUsd - a.totals.spendUsd;
      if (spendDiff !== 0) {
        return spendDiff;
      }
      const purchaseDiff = b.totals.purchaseCount - a.totals.purchaseCount;
      if (purchaseDiff !== 0) {
        return purchaseDiff;
      }
      return a.productName.localeCompare(b.productName, "ko-KR", { numeric: true, sensitivity: "base" });
    });
}

function sortCreativeRows(rows: CreativePerformanceRow[]) {
  return [...rows].sort((a, b) => {
    const statusDiff = statusRank(a.deliveryStatus) - statusRank(b.deliveryStatus);
    if (statusDiff !== 0) {
      return statusDiff;
    }
    const spendDiff = b.totals.spendUsd - a.totals.spendUsd;
    if (spendDiff !== 0) {
      return spendDiff;
    }
    const purchaseDiff = b.totals.purchaseCount - a.totals.purchaseCount;
    if (purchaseDiff !== 0) {
      return purchaseDiff;
    }
    return (a.materialNo ?? a.displayName).localeCompare(b.materialNo ?? b.displayName, "ko-KR", {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function aggregateProductRows(rows: CreativePerformanceRow[]): ProductTotals {
  const spendUsd = sum(rows.map((row) => row.totals.spendUsd));
  const purchaseCount = sum(rows.map((row) => row.totals.purchaseCount));
  const hasUnknownSpendKrw = rows.some(
    (row) => row.totals.spendUsd > 0 && !isKnownNumber(row.totals.spendKrw)
  );
  const hasUnknownRevenueKrw = rows.some(
    (row) => row.totals.purchaseCount > 0 && !isKnownNumber(row.totals.revenueKrw)
  );
  const spendKrw = hasUnknownSpendKrw ? null : sum(rows.map((row) => row.totals.spendKrw));
  const revenueKrw = hasUnknownRevenueKrw ? null : sum(rows.map((row) => row.totals.revenueKrw));

  return {
    spendUsd,
    spendKrw,
    purchaseCount,
    cpaUsd: purchaseCount > 0 ? spendUsd / purchaseCount : null,
    cpaKrw: spendKrw !== null && purchaseCount > 0 ? spendKrw / purchaseCount : null,
    revenueKrw,
    roas: spendKrw !== null && revenueKrw !== null && spendKrw > 0 ? revenueKrw / spendKrw : null
  };
}

function buildPreviousIndexes(rows: CreativePerformanceRow[]): PreviousIndexes {
  const byCreativeKey = new Map<string, CreativePerformanceRow>();
  const byProductMaterial = new Map<string, CreativePerformanceRow>();
  const byDisplayName = new Map<string, CreativePerformanceRow>();

  for (const row of rows) {
    if (row.creativeKey) {
      byCreativeKey.set(row.creativeKey, row);
    }
    const productMaterialKey = productMaterialLookupKey(row);
    if (productMaterialKey) {
      byProductMaterial.set(productMaterialKey, row);
    }
    if (row.displayName) {
      byDisplayName.set(row.displayName, row);
    }
  }

  return { byCreativeKey, byProductMaterial, byDisplayName };
}

function findPreviousRow(row: CreativePerformanceRow, indexes: PreviousIndexes) {
  if (row.creativeKey) {
    const byCreativeKey = indexes.byCreativeKey.get(row.creativeKey);
    if (byCreativeKey) {
      return byCreativeKey;
    }
  }
  const productMaterialKey = productMaterialLookupKey(row);
  if (productMaterialKey) {
    const byProductMaterial = indexes.byProductMaterial.get(productMaterialKey);
    if (byProductMaterial) {
      return byProductMaterial;
    }
  }
  return indexes.byDisplayName.get(row.displayName) ?? null;
}

function productMaterialLookupKey(row: CreativePerformanceRow) {
  if (!row.productName || !row.materialNo) {
    return null;
  }
  return `${row.productName.trim().toLowerCase()}:${row.materialNo.trim().toLowerCase()}`;
}

function toggleColumn(columns: ColumnKey[], key: ColumnKey) {
  if (columns.includes(key)) {
    return columns.length === 1 ? columns : columns.filter((column) => column !== key);
  }
  return [...columns, key];
}

function readDailyReportSettings(): DailyReportSettings {
  if (typeof window === "undefined") {
    return DEFAULT_DAILY_REPORT_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(DAILY_REPORT_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_DAILY_REPORT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<DailyReportSettings>;
    const parsedColumns = Array.isArray(parsed.visibleColumns)
      ? parsed.visibleColumns.filter(isColumnKey)
      : DEFAULT_DAILY_REPORT_SETTINGS.visibleColumns;
    const visibleColumns =
      parsedColumns.length > 0
        ? DAILY_REPORT_COLUMNS.map((column) => column.key).filter((key) => parsedColumns.includes(key))
        : DEFAULT_DAILY_REPORT_SETTINGS.visibleColumns;
    return {
      query: typeof parsed.query === "string" ? parsed.query : DEFAULT_DAILY_REPORT_SETTINGS.query,
      deliveryStatus: isDeliveryStatus(parsed.deliveryStatus)
        ? parsed.deliveryStatus
        : DEFAULT_DAILY_REPORT_SETTINGS.deliveryStatus,
      visibleColumns
    };
  } catch {
    return DEFAULT_DAILY_REPORT_SETTINGS;
  }
}

function writeDailyReportSettings(settings: DailyReportSettings) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DAILY_REPORT_SETTINGS_KEY, JSON.stringify(settings));
}

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (isKnownNumber(value) ? value : 0), 0);
}

function isKnownNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && !Number.isNaN(value);
}

function formatCpa(totals: { cpaKrw?: number | null; cpaUsd?: number | null }) {
  if (totals.cpaKrw !== null && totals.cpaKrw !== undefined) {
    return money(totals.cpaKrw, "KRW");
  }
  return money(totals.cpaUsd, "USD");
}

function formatPercent(value: number | null | undefined) {
  if (!isKnownNumber(value)) {
    return "-";
  }
  return `${numberFmt(value, 2)}%`;
}

function formatRoas(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return `${numberFmt(value * 100, 2)}%`;
}

function formatStatus(value: string | null) {
  if (!value) {
    return "-";
  }
  if (value.toLowerCase() === "active") {
    return "활성";
  }
  if (value.toLowerCase() === "inactive" || value.toLowerCase() === "not_delivering") {
    return "비활성";
  }
  return value;
}

function statusClass(value: string | null) {
  const normalized = value?.toLowerCase();
  if (normalized === "active") {
    return "active";
  }
  if (normalized === "inactive" || normalized === "not_delivering") {
    return "inactive";
  }
  return "";
}

function statusRank(value: string | null) {
  return statusClass(value) === "active" ? 0 : 1;
}

function isDeliveryStatus(value: unknown): value is DeliveryStatusFilter {
  return value === "active" || value === "inactive" || value === "all" || value === "hasSpend";
}

function isColumnKey(value: unknown): value is ColumnKey {
  return DAILY_REPORT_COLUMNS.some((column) => column.key === value);
}
