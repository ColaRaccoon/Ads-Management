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
  productId: string | null;
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
  productId: string | null;
  rows: CreativePerformanceRow[];
  totals: ProductTotals;
};

type ReportProductGroup = ProductGroup & {
  salesRow: SalesProductRow | null;
  salesOnly: boolean;
};

type SalesProductPerformance = {
  rows: SalesProductRow[];
  summary: {
    salesLineCount: number;
    salesUnmatchedCount: number;
    adUnmatchedMetricCount: number;
    adUnmatchedSpendKrw: number | null;
  };
};

type SalesProductRow = {
  productId: string;
  product?: { displayName?: string | null; name?: string | null; code?: string | null } | null;
  quantity: number;
  revenueKrw: number;
  totalPaidKrw: number;
  adSpendUsd?: number | null;
  adSpendKrw: number | null;
  grossCostKrw: number | null;
  totalCostKrw: number | null;
  marginKrw: number | null;
  marginRate: number | null;
  matchedSalesLineCount: number;
};

type SalesProductIndex = {
  byProductId: Map<string, SalesProductRow>;
  byProductName: Map<string, SalesProductNameMatch>;
};

type SalesProductNameMatch = {
  row: SalesProductRow;
  ambiguous: boolean;
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

  const salesPerformance = useQuery({
    queryKey: ["daily-report-sales-product-performance", reportDate, apiDeliveryStatus],
    queryFn: () =>
      apiGet<SalesProductPerformance>(
        `/sales/product-performance?${rangeQuery(
          { from: reportDate, to: reportDate },
          { deliveryStatus: apiDeliveryStatus }
        )}`
      ),
    enabled: settingsLoaded
  });

  const filteredRows = useMemo(
    () => filterRows(current.data ?? [], deliveryStatus),
    [current.data, deliveryStatus]
  );
  const productGroups = useMemo(() => groupRowsByProduct(filteredRows), [filteredRows]);
  const salesProductIndex = useMemo(
    () => buildSalesProductIndex(salesPerformance.data?.rows ?? []),
    [salesPerformance.data?.rows]
  );
  const reportGroups = useMemo(
    () => buildReportProductGroups(productGroups, salesPerformance.data?.rows ?? [], salesProductIndex, query),
    [productGroups, query, salesPerformance.data?.rows, salesProductIndex]
  );
  const reportTotals = useMemo(() => aggregateProductRows(filteredRows), [filteredRows]);
  const previousIndexes = useMemo(() => buildPreviousIndexes(previous.data ?? []), [previous.data]);
  const selectedColumns = useMemo(
    () => DAILY_REPORT_COLUMNS.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns]
  );
  const isLoading = current.isLoading || previous.isLoading || salesPerformance.isLoading || !settingsLoaded;

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

      {current.isError || previous.isError || salesPerformance.isError ? (
        <div className="warning-strip no-print">
          <span>API 연결 또는 DB 설정을 확인해주세요.</span>
          {salesPerformance.isError ? <span>카페24 실매출 데이터를 불러오지 못했습니다.</span> : null}
        </div>
      ) : null}

      <DailyReportSummary productCount={reportGroups.length} totals={reportTotals} />

      {isLoading ? (
        <div className="daily-report-empty">보고 데이터를 불러오는 중입니다.</div>
      ) : reportGroups.length === 0 ? (
        <div className="daily-report-empty">조건에 맞는 소재 또는 카페24 실매출 데이터가 없습니다.</div>
      ) : (
        <div className="daily-product-list">
          {reportGroups.map((group) => (
            <ProductReportBox
              key={group.productId ?? group.productName}
              columns={selectedColumns}
              group={group}
              previousIndexes={previousIndexes}
              reportDate={reportDate}
              salesIsError={salesPerformance.isError}
              salesIsLoading={salesPerformance.isLoading}
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
  reportDate,
  salesIsError,
  salesIsLoading
}: {
  columns: ColumnDefinition[];
  group: ReportProductGroup;
  previousIndexes: PreviousIndexes;
  reportDate: string;
  salesIsError: boolean;
  salesIsLoading: boolean;
}) {
  return (
    <article className="daily-product-box">
      <ProductReportHeader group={group} />
      <ProductCreativeTable columns={columns} previousIndexes={previousIndexes} rows={group.rows} />
      <ProductSalesMarginSection isError={salesIsError} isLoading={salesIsLoading} row={group.salesRow} />
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
          {rows.length === 0 ? (
            <tr>
              <td className="daily-product-table-empty" colSpan={columns.length}>
                표시할 Meta 소재가 없습니다.
              </td>
            </tr>
          ) : rows.map((row) => {
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

function ProductSalesMarginSection({
  isError,
  isLoading,
  row
}: {
  isError: boolean;
  isLoading: boolean;
  row: SalesProductRow | null;
}) {
  return (
    <section className="daily-sales-margin">
      <h3>카페24 실매출 기반 마진</h3>
      {isLoading ? (
        <p className="daily-sales-empty">카페24 실매출 데이터를 불러오는 중입니다.</p>
      ) : isError ? (
        <p className="daily-sales-empty">카페24 실매출 데이터를 불러오지 못했습니다.</p>
      ) : !row ? (
        <p className="daily-sales-empty">매칭되는 카페24 실매출 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="daily-sales-table-wrap">
            <table className="daily-sales-table">
              <thead>
                <tr>
                  <th>제품</th>
                  <th>판매수량</th>
                  <th>실매출</th>
                  <th>실결제액</th>
                  <th>상품 비용</th>
                  <th>광고비</th>
                  <th>총비용</th>
                  <th>실제 마진</th>
                  <th>마진율</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <span className="daily-sales-product-cell">
                      <strong>{salesProductLabel(row)}</strong>
                      <small>판매 행 {numberFmt(row.matchedSalesLineCount)}</small>
                    </span>
                  </td>
                  <td>{numberFmt(row.quantity)}</td>
                  <td>{money(row.revenueKrw, "KRW")}</td>
                  <td>{money(row.totalPaidKrw, "KRW")}</td>
                  <td>{money(row.grossCostKrw, "KRW")}</td>
                  <td>{money(row.adSpendKrw, "KRW")}</td>
                  <td>{money(row.totalCostKrw, "KRW")}</td>
                  <td>{money(row.marginKrw, "KRW")}</td>
                  <td>{formatMarginRate(row.marginRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {row.matchedSalesLineCount === 0 ? (
            <p className="daily-sales-note">해당 기준일에 매칭된 카페24 판매 행이 없어 0 기준으로 표시합니다.</p>
          ) : null}
        </>
      )}
    </section>
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
    const groupKey = productGroupKey(row);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }

  return Array.from(groups.values())
    .map((productRows) => ({
      productName: firstNonEmpty(productRows.map((row) => row.productName?.trim())) ?? "제품명 미파싱",
      productId: firstNonNull(productRows.map((row) => row.productId)),
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

function buildSalesProductIndex(rows: SalesProductRow[]): SalesProductIndex {
  const byProductId = new Map<string, SalesProductRow>();
  const byProductName = new Map<string, SalesProductNameMatch>();

  for (const row of rows) {
    byProductId.set(row.productId, row);
    addSalesProductName(byProductName, row.product?.displayName, row);
    addSalesProductName(byProductName, row.product?.name, row);
    addSalesProductName(byProductName, row.product?.code, row);
  }

  return { byProductId, byProductName };
}

function buildReportProductGroups(
  productGroups: ProductGroup[],
  salesRows: SalesProductRow[],
  salesProductIndex: SalesProductIndex,
  query: string
): ReportProductGroup[] {
  const matchedSalesProductIds = new Set<string>();
  const groups = productGroups.map((group) => {
    const salesRow = findSalesRowForGroup(group, salesProductIndex);
    if (salesRow) {
      matchedSalesProductIds.add(salesRow.productId);
    }
    return {
      ...group,
      salesRow,
      salesOnly: false
    };
  });
  const normalizedQuery = normalizeLookupText(query);
  const salesOnlyGroups = salesRows
    .filter((row) => !matchedSalesProductIds.has(row.productId))
    .filter((row) => salesRowMatchesQuery(row, normalizedQuery))
    .sort((a, b) => salesProductLabel(a).localeCompare(salesProductLabel(b), "ko-KR", { numeric: true, sensitivity: "base" }))
    .map(
      (row): ReportProductGroup => ({
        productName: salesProductLabel(row),
        productId: row.productId,
        rows: [],
        totals: emptyProductTotals(),
        salesRow: row,
        salesOnly: true
      })
    );

  return [...groups, ...salesOnlyGroups].filter(reportGroupHasActivity);
}

function reportGroupHasActivity(group: ReportProductGroup) {
  return (
    hasNonZeroNumber(group.totals.spendUsd) ||
    hasNonZeroNumber(group.totals.spendKrw) ||
    hasNonZeroNumber(group.totals.purchaseCount) ||
    hasNonZeroNumber(group.totals.revenueKrw) ||
    salesRowHasActivity(group.salesRow)
  );
}

function salesRowHasActivity(row: SalesProductRow | null) {
  if (!row) {
    return false;
  }
  return (
    hasNonZeroNumber(row.quantity) ||
    hasNonZeroNumber(row.revenueKrw) ||
    hasNonZeroNumber(row.totalPaidKrw) ||
    hasNonZeroNumber(row.adSpendUsd) ||
    hasNonZeroNumber(row.adSpendKrw)
  );
}

function findSalesRowForGroup(group: ProductGroup, index: SalesProductIndex) {
  if (group.productId) {
    return index.byProductId.get(group.productId) ?? null;
  }
  const nameMatch = index.byProductName.get(normalizeLookupText(group.productName));
  return nameMatch && !nameMatch.ambiguous ? nameMatch.row : null;
}

function addSalesProductName(index: Map<string, SalesProductNameMatch>, value: string | null | undefined, row: SalesProductRow) {
  const key = normalizeLookupText(value);
  if (!key) {
    return;
  }
  const existing = index.get(key);
  if (!existing) {
    index.set(key, { row, ambiguous: false });
    return;
  }
  if (existing.row.productId !== row.productId) {
    index.set(key, { row: existing.row, ambiguous: true });
  }
}

function salesRowMatchesQuery(row: SalesProductRow, normalizedQuery: string) {
  if (!normalizedQuery) {
    return true;
  }
  return [row.product?.displayName, row.product?.name, row.product?.code, row.productId].some((value) =>
    normalizeLookupText(value).includes(normalizedQuery)
  );
}

function emptyProductTotals(): ProductTotals {
  return {
    spendUsd: 0,
    spendKrw: 0,
    purchaseCount: 0,
    cpaUsd: null,
    cpaKrw: null,
    revenueKrw: 0,
    roas: null
  };
}

function productGroupKey(row: CreativePerformanceRow) {
  if (row.productId) {
    return `id:${row.productId}`;
  }
  const nameKey = normalizeLookupText(row.productName);
  return `name:${nameKey || "제품명 미파싱"}`;
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

function hasNonZeroNumber(value: number | null | undefined) {
  return isKnownNumber(value) && Math.abs(value) > 0;
}

function salesProductLabel(row: SalesProductRow) {
  return row.product?.displayName ?? row.product?.name ?? row.product?.code ?? row.productId;
}

function formatMarginRate(value: number | null | undefined) {
  if (!isKnownNumber(value)) {
    return "-";
  }
  return `${numberFmt(value * 100, 2)}%`;
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

function firstNonNull<T>(values: Array<T | null | undefined>) {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function firstNonEmpty(values: Array<string | null | undefined>) {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function normalizeLookupText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .split(/\s+/)
    .join("")
    .toLowerCase();
}

function isDeliveryStatus(value: unknown): value is DeliveryStatusFilter {
  return value === "active" || value === "inactive" || value === "all" || value === "hasSpend";
}

function isColumnKey(value: unknown): value is ColumnKey {
  return DAILY_REPORT_COLUMNS.some((column) => column.key === value);
}
