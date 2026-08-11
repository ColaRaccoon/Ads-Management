"use client";

import { useMemo } from "react";
import {
  DailyReportPrintHeader,
  DailyReportToolbar
} from "@/features/meta-daily-report/components/daily-report-toolbar";
import { DailyReportSummary } from "@/features/meta-daily-report/components/daily-report-summary";
import { ProductReportBox } from "@/features/meta-daily-report/components/product-report-box";
import { useMetaDailyReportData } from "@/features/meta-daily-report/use-meta-daily-report-data";
import { useMetaDailyReportSettings } from "@/features/meta-daily-report/use-meta-daily-report-settings";
import { META_DAILY_COLUMNS } from "@/lib/meta-daily-columns";
import { buildMetaDailyXlsxWorkbook } from "@/lib/meta-daily-xlsx";
import { useRange } from "@/lib/use-range";
import { downloadXlsx } from "@/lib/xlsx";

export default function DailyReportPage() {
  const range = useRange();
  const {
    settingsLoaded,
    query,
    setQuery,
    deliveryStatus,
    setDeliveryStatus,
    visibleColumns,
    toggleVisibleColumn
  } = useMetaDailyReportSettings();
  const reportDate = range.to;
  const {
    previousDate,
    reportGroups,
    reportTotals,
    previousIndexes,
    isLoading,
    currentIsError,
    previousIsError,
    salesIsError,
    salesIsLoading
  } = useMetaDailyReportData({ reportDate, query, deliveryStatus, settingsLoaded });
  const selectedColumns = useMemo(
    () => META_DAILY_COLUMNS.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns]
  );
  const exportDisabled = isLoading || currentIsError || previousIsError || salesIsError || reportGroups.length === 0;

  const exportXlsx = () => {
    const workbook = buildMetaDailyXlsxWorkbook({
      reportDate,
      productCount: reportGroups.length,
      totals: reportTotals,
      visibleColumns: selectedColumns.map((column) => column.key),
      groups: reportGroups.map((group) => ({
        productName: group.productName,
        productId: group.productId,
        totals: group.totals,
        salesRow: group.salesRow,
        rows: group.rows
      }))
    });
    downloadXlsx(`${reportDate}_메타_데일리리포트.xlsx`, workbook);
  };

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
          exportDisabled={exportDisabled}
          onDeliveryStatusChange={setDeliveryStatus}
          onExportXlsx={exportXlsx}
          onPrint={() => window.print()}
          onQueryChange={setQuery}
          onToggleColumn={toggleVisibleColumn}
        />
      </div>

      <DailyReportPrintHeader previousDate={previousDate} reportDate={reportDate} />

      {currentIsError || previousIsError || salesIsError ? (
        <div className="warning-strip no-print">
          <span>API 연결 또는 DB 설정을 확인해주세요.</span>
          {salesIsError ? <span>카페24 실매출 데이터를 불러오지 못했습니다.</span> : null}
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
              salesIsError={salesIsError}
              salesIsLoading={salesIsLoading}
            />
          ))}
        </div>
      )}
    </section>
  );
}
