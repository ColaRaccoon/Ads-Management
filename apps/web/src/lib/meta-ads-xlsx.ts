import type { MetaCreativePerformanceRow } from "@/types/meta";
import { formatMetaDeliveryStatus, META_VIDEO_RATE_COLUMNS, percentToRatio } from "./meta-video-display";
import { buildXlsxWorkbook, type XlsxCell, type XlsxCellStyle, type XlsxWorkbookInput } from "./xlsx";

type MetaAdsExportColumn = {
  header: string;
  width: number;
  style: XlsxCellStyle;
  value: (row: MetaCreativePerformanceRow) => XlsxCell["value"];
};

const META_ADS_EXPORT_COLUMNS: MetaAdsExportColumn[] = [
  { header: "제품", width: 18, style: "Text", value: (row) => row.productName ?? "-" },
  { header: "소재", width: 18, style: "Text", value: (row) => row.materialNo ?? row.displayName },
  { header: "활성상태", width: 12, style: "Text", value: (row) => formatMetaDeliveryStatus(row.deliveryStatus) },
  { header: "집계일수", width: 11, style: "Number", value: (row) => row.dataDays },
  { header: "광고비", width: 14, style: "Usd", value: (row) => row.totals.spendUsd },
  { header: "구매", width: 10, style: "Number", value: (row) => row.totals.purchaseCount },
  { header: "CPA", width: 14, style: "Usd", value: (row) => row.totals.cpaUsd },
  { header: "CTR", width: 10, style: "Percent", value: (row) => percentToRatio(row.totals.ctrLinkPct) },
  { header: "CPM", width: 14, style: "Usd", value: (row) => row.totals.cpmUsd },
  { header: "도달", width: 12, style: "Number", value: (row) => row.totals.reach },
  ...META_VIDEO_RATE_COLUMNS.map((column): MetaAdsExportColumn => ({
    header: column.label,
    width: column.key === "videoPlay100RatePct" ? 14 : 13,
    style: "Percent",
    value: (row) => percentToRatio(row.totals[column.key])
  }))
];

export function buildMetaAdsXlsxInput(rows: MetaCreativePerformanceRow[]): XlsxWorkbookInput {
  return {
    sheetName: "Ads",
    columns: META_ADS_EXPORT_COLUMNS.map((column) => ({ width: column.width })),
    rows: [
      META_ADS_EXPORT_COLUMNS.map((column): XlsxCell => ({ value: column.header, style: "Header" })),
      ...rows.map((row) => META_ADS_EXPORT_COLUMNS.map((column): XlsxCell => ({
        value: column.value(row),
        style: column.style
      })))
    ],
    freezeRow: 1,
    autoFilter: { fromRow: 1 }
  };
}

export function buildMetaAdsXlsxWorkbook(rows: MetaCreativePerformanceRow[]) {
  return buildXlsxWorkbook(buildMetaAdsXlsxInput(rows));
}
