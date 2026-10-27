import type { GoogleReportResponse } from "../types/google";
import { GOOGLE_DAILY_COLUMNS, googleCampaignKey, googleDailyCampaignValue, googleDailySalesMetrics, type GoogleDailyColumnKey, type GoogleDailyGroup } from "./google-daily-report";
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
  const count = Math.max(11, columns.reduce((total, column) => total + (column.key === "campaign" ? 1 : 2), 0));
  const input: XlsxWorkbookInput = { sheetName: "Google 데일리 리포트", columns: Array.from({ length: count }, (_, i) => ({ width: i ? 16 : 30 })), rows: [], merges: [] };
  const banner = (text: string, fill: XlsxCell["fill"] = "REPORT_HEADER") => {
    input.rows.push({ height: 32, cells: [{ value: text, style: "Text", bold: true, fill, wrapText: true }] });
    input.merges!.push({ fromRow: input.rows.length, toRow: input.rows.length, fromColumn: 1, toColumn: count });
  };
  banner(`Google Daily Report · ${report.reportDate} · 전일 ${report.previousDate}`);
  banner(`표시 조건: ${report.filterLabel} · 합계는 전체 조회 범위 기준입니다.`, "GROUP_SAND");
  banner("[유튜브] 판매 기준 · 설정가 매출 및 수집 판매금액은 실결제액/Google 전환매출이 아닙니다.", "GROUP_SAND");
  if (!report.data.completeness.complete || !report.previous.completeness.complete || !report.data.reconciliation.balanced) {
    banner("현재 또는 전일에 미확정 데이터가 있습니다. 빈 지표는 0이 아닌 미확정/자료 없음입니다.", "GROUP_SAND");
  }
  input.rows.push(["전체 제품수", "총 광고비 KRW", "총 판매수량", "판매 1개당 광고비", "페이지 기준 ROAS", "최종 순마진"].map(value => ({ value, style: "Header" })));
  const total = report.data.summary;
  input.rows.push([
    numeric(report.data.products.filter(row => row.productId !== null).length, "TotalNumber"),
    numeric(total.adSpendKrwExact, "TotalKrw"), numeric(total.quantity, "TotalNumber"),
    numeric(total.costPerSaleKrw, "TotalKrw"), numeric(total.roas, "TotalRatio"), numeric(total.marginKrw, "TotalKrw")
  ]);
  input.freezeRow = input.rows.length;
  const previous = new Map(report.previous.campaigns.map(row => [googleCampaignKey(row), row]));
  for (const group of report.groups) {
    input.rows.push([]);
    banner(`${group.productName} · ${group.campaigns.length}개 캠페인 · ${group.sales.complete ? "확정" : "미확정"}`, "GROUP_MINT");
    input.rows.push({ height: 36, cells: columns.flatMap<XlsxCell>(column => column.key === "campaign"
      ? [{ value: column.label, style: "Header" as const }]
      : [report.reportDate, report.previousDate].map(date => ({ value: `${column.label}\n${date}`, style: "Header" as const, wrapText: true }))) });
    for (const row of group.campaigns) {
      const prior = previous.get(googleCampaignKey(row));
      input.rows.push({ height: 48, cells: columns.flatMap(column => {
        if (column.key === "campaign") return [{ value: `${row.campaignName}\n${row.customerId} · ${row.campaignId}`, style: "Text" as const, wrapText: true }];
        const style = column.key === "ctr" ? "Percent0" : column.key === "impressions" || column.key === "clicks" ? "Number" : "Krw";
        return [numeric(googleDailyCampaignValue(row, column.key), style), numeric(googleDailyCampaignValue(prior, column.key), style)];
      }) });
    }
    if (!group.campaigns.length) banner("해당 날짜에 연결된 Google 캠페인이 없습니다.", "GROUP_SAND");
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
