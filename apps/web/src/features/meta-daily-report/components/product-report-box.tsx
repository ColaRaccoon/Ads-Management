import type { ColumnDefinition, PreviousIndexes, ReportProductGroup } from "../types";
import { formatMetaCurrentObservations } from "@/lib/meta-current-metadata-display";
import { formatMetaMetricReasons } from "@/lib/meta-conditional-display";
import { ProductChangeLogSection } from "./product-change-log-section";
import { ProductCreativeTable } from "./product-creative-table";
import { ProductReportHeader } from "./product-report-header";
import { ProductSalesMarginSection } from "./product-sales-margin-section";

export function ProductReportBox({
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
      <details className="meta-report-details muted">
        <summary>지표 기준 및 수집 정보</summary>
        <p>CPA는 원화 광고비 ÷ 구매건수, Meta ROAS는 Meta 구매전환금액 ÷ 달러 광고비입니다. Meta ROAS는 공급자 기본 기여 기준이며 과거 CSV에 구매전환금액이 없으면 표시하지 않습니다.</p>
        <p>집계일수는 저장된 최초 관측일부터 조회 종료일 이전의 마지막 관측일까지의 기간입니다. 중간에 광고비가 없는 날짜도 포함합니다.</p>
        <p>{formatMetaMetricReasons(group.totals.metricUnavailableReasons)}</p>
        {[...new Set(group.rows.map((row) => formatMetaCurrentObservations(row.currentMetadataObservations)).filter(Boolean))].map((text, index) =>
          <p key={index}>{text}</p>)}
      </details>
      <ProductCreativeTable columns={columns} previousIndexes={previousIndexes} rows={group.rows} />
      <ProductSalesMarginSection isError={salesIsError} isLoading={salesIsLoading} row={group.salesRow} />
      <ProductChangeLogSection productName={group.productName} reportDate={reportDate} />
    </article>
  );
}
