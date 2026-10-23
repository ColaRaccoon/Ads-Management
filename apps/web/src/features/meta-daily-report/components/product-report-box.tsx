import type { ColumnDefinition, PreviousIndexes, ReportProductGroup } from "../types";
import { formatMetaCurrentObservations } from "@/lib/meta-current-metadata-display";
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
      {group.rows.map((row) => formatMetaCurrentObservations(row.currentMetadataObservations)).filter(Boolean).map((text, index) =>
        <p className="muted" key={index}>{text}</p>)}
      <ProductCreativeTable columns={columns} previousIndexes={previousIndexes} rows={group.rows} />
      <ProductSalesMarginSection isError={salesIsError} isLoading={salesIsLoading} row={group.salesRow} />
      <ProductChangeLogSection productName={group.productName} reportDate={reportDate} />
    </article>
  );
}
