import type { GoogleReportResponse } from "../types/google";
import { GOOGLE_DAILY_COLUMNS, googleCreativeKey, googleDailyCreativeValue, googleDailyCreativeTotals, googleDailySalesMetrics, type GoogleDailyColumnKey, type GoogleDailyGroup } from "./google-daily-report";
import { buildXlsxWorkbook, type XlsxCell, type XlsxCellStyle, type XlsxWorkbookInput } from "./xlsx";
import { googleReasons } from "./google-display";

export type GoogleDailyExport = {
  reportDate: string; previousDate: string; data: GoogleReportResponse; previous: GoogleReportResponse;
  groups: GoogleDailyGroup[]; columns: GoogleDailyColumnKey[]; filterLabel: string;
};
const numeric = (value: number | string | null | undefined, style: XlsxCellStyle): XlsxCell => ({
  value: value == null || !Number.isFinite(Number(value)) ? "" : Number(value), style
});

export function buildGoogleDailyXlsxInput(report: GoogleDailyExport): XlsxWorkbookInput {
  const columns = GOOGLE_DAILY_COLUMNS.filter(column => report.columns.includes(column.key));
  const count = Math.max(11, columns.reduce((total, column) => total + (column.key === "creative" ? 1 : 2), 0));
  const input: XlsxWorkbookInput = { sheetName: "Google 데일리 리포트", columns: Array.from({ length: count }, (_, i) => ({ width: i ? 14 : 42 })), rows: [], merges: [],
    print: { orientation: "landscape", paperSize: "A4", fitToWidth: 1, fitToHeight: 0 } };
  const banner = (text: string, fill: XlsxCell["fill"] = "REPORT_HEADER") => {
    input.rows.push({ height: 32, cells: [{ value: text, style: "Text", bold: true, fill, wrapText: true }] });
    input.merges!.push({ fromRow: input.rows.length, toRow: input.rows.length, fromColumn: 1, toColumn: count });
  };
  banner(`Google Daily Report · ${report.reportDate} · 전일 ${report.previousDate}`);
  if (!report.data.completeness.complete || !report.previous.completeness.complete || !report.data.reconciliation.balanced ||
      report.data.creativeCompleteness?.complete !== true || report.previous.creativeCompleteness?.complete !== true) {
    banner("현재 또는 전일에 미확정 데이터가 있습니다. 빈 지표는 0이 아닌 미확정/자료 없음입니다.", "GROUP_SAND");
  }
  input.rows.push(["전체 제품수", "총 광고비 KRW", "총 구매 전환수", "구매 CPA (원)", "Google ROAS", "최종 순마진"].map(value => ({ value, style: "Header" })));
  const total = report.data.summary;
  const creativeTotal = googleDailyCreativeTotals(report.data);
  input.rows.push([
    numeric(report.data.products.filter(row => row.productId !== null).length, "TotalNumber"),
    numeric(creativeTotal.spend, "TotalKrw"), numeric(creativeTotal.purchases, "Decimal"),
    numeric(creativeTotal.cpa, "TotalKrw"), numeric(creativeTotal.roas, "TotalRatio"), numeric(total.marginKrw, "TotalKrw")
  ]);
  input.freezeRow = input.rows.length;
  const previous = new Map((report.previous.creatives ?? []).map(row => [googleCreativeKey(row), row]));
  for (const group of report.groups) {
    input.rows.push([]);
    banner(`${group.productName} · ${group.creatives.length}개 소재 · ${group.sales.complete ? "확정" : "미확정"}`, "GROUP_MINT");
    input.rows.push({ height: 36, cells: columns.flatMap<XlsxCell>(column => column.key === "creative"
      ? [{ value: column.label, style: "Header" as const }]
      : [report.reportDate, report.previousDate].map(date => ({ value: `${column.label}\n${date}`, style: "Header" as const, wrapText: true }))) });
    for (const row of group.creatives) {
      const prior = previous.get(googleCreativeKey(row));
      input.rows.push({ height: 48, cells: columns.flatMap(column => {
        if (column.key === "creative") return [{ value: `${row.adName}\n${row.campaignName} · ${row.adId}`, style: "Text" as const, wrapText: true }];
        const style: XlsxCellStyle = column.key === "ctr" || column.key === "videoViewRate" || column.key.startsWith("videoP") ? "Percent1"
          : column.key === "purchaseRoas" ? "Ratio" : column.key === "purchaseCount" ? "Decimal"
          : ["impressions", "clicks", "videoViews"].includes(column.key) ? "Number" : "Krw";
        return [numeric(googleDailyCreativeValue(row, column.key), style), numeric(googleDailyCreativeValue(prior, column.key), style)];
      }) });
    }
    if (!group.creatives.length) banner("해당 날짜에 연결된 Google 소재이 없습니다.", "GROUP_SAND");
    banner("카페24 [유튜브] 판매 기반 마진", "GROUP_BLUE");
    const sales = googleDailySalesMetrics(group.sales);
    input.rows.push({ height: 36, cells: ["제품", ...sales.map(metric => metric.label)].map(value => ({ value, style: "Header", wrapText: true })) });
    input.rows.push({ height: 32, cells: [{ value: group.productName, style: "Text", wrapText: true }, ...sales.map(metric => numeric(metric.value,
      metric.kind === "number" ? "Number" : metric.kind === "percent" ? "Percent0" : "Krw"))] });
    if (group.sales.warningCodes.length) banner(`확인 사유: ${googleReasons(group.sales.warningCodes)}`, "GROUP_SAND");
  }
  return input;
}

export const buildGoogleDailyXlsx = (report: GoogleDailyExport) => buildXlsxWorkbook(buildGoogleDailyXlsxInput(report));
