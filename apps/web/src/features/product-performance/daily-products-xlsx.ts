import { buildXlsxWorkbook, type XlsxCell, type XlsxCellStyle, type XlsxMultiSheetWorkbookInput, type XlsxWorkbookInput } from "../../lib/xlsx";
import {
  DAILY_PRODUCT_GROUPS, DAILY_PRODUCT_METRICS, dailyProductChange, dailyProductMoney, dailyProductStateLabel,
  type ComparedMetric, type DailyProductRow, type DailyProductsReport
} from "./daily-products-model";

/** Canonical decimal text also accepts Number#toString scientific notation for a round-trip check. */
function canonicalDecimal(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  const digits = match[2] + (match[3] ?? ""), point = match[2].length + exponent;
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length
    ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fraction = ""] = expanded.split(".");
  const number = (whole.replace(/^0+(?=\d)/, "") || "0") + (fraction.replace(/0+$/, "") ? `.${fraction.replace(/0+$/, "")}` : "");
  return match[1] && /[1-9]/.test(number) ? `-${number}` : number;
}

function percentageRatio(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  // Shift exactly two decimal places; dividing a Number first could round the stored rate.
  return canonicalDecimal(`${match[1]}${match[2]}.${match[3] ?? ""}e-2`.replace(".e", "e"));
}

/** Excel keeps at most 15 significant decimal digits. Preserve other values as text. */
function numberCell(value: string | null, style: XlsxCellStyle, percent = false): { cell: XlsxCell; text: boolean } {
  if (value === null) return { cell: { value: "", style }, text: false };
  const normalized = percent ? percentageRatio(value) : canonicalDecimal(value);
  const numeric = normalized === null ? NaN : Number(normalized);
  const significantDigits = normalized?.replace(/[-.]/g, "").replace(/^0+|0+$/g, "").length ?? 16;
  if (normalized !== null && significantDigits <= 15 && Number.isFinite(numeric) && canonicalDecimal(String(numeric)) === normalized) {
    return { cell: { value: numeric, style }, text: false };
  }
  return { cell: { value: percent ? `${value}%` : value, style: "Text" }, text: true };
}

const part = (metric: ComparedMetric) => metric.current.state === "PARTIAL" || metric.previous.state === "PARTIAL";
function reportCell(metric: ComparedMetric, total: boolean): XlsxCell {
  const unavailable = metric.current.state === "NOT_APPLICABLE" || metric.current.state === "EXCLUDED";
  const amount = unavailable ? dailyProductStateLabel(metric.current) : dailyProductMoney(metric.current.value);
  return { value: `${amount}${metric.current.state === "PARTIAL" ? "*" : ""}${metric.current.isEstimate ? "†" : ""}\n(${dailyProductChange(metric)})${part(metric) ? "*" : ""}${metric.current.isEstimate || metric.previous.isEstimate ? "†" : ""}`,
    style: total ? "TotalText" : "Text", fontSize: 8, wrapText: true,
    ...(total ? { fill: "REPORT_TOTAL" as const } : {}) };
}

export function buildDailyProductsXlsxInput(report: DailyProductsReport): XlsxMultiSheetWorkbookInput {
  const sheet: XlsxWorkbookInput = {
    sheetName: "전체 제품 데일리", columns: Array.from({ length: 16 }, (_, index) => ({ width: index === 0 ? 20 : 9 })),
    rows: [], merges: [], freezeColumn: 1
  };
  const banner = (text: string, height = 27) => {
    sheet.rows.push({ height, cells: [{ value: text, style: "Text", fontSize: 8, wrapText: true }] });
    sheet.merges!.push({ fromRow: sheet.rows.length, toRow: sheet.rows.length, fromColumn: 1, toColumn: 16 });
  };
  banner(`제품 통합 데일리 · ${report.date} · 전일 ${report.previousDate} · 전체 ${report.rows.length}제품`);
  banner(`${report.scopeLabel} · 금액 단위: 원 · 순이익은 기존 플랫폼 계산 기준${report.provisional ? " · 잠정 자료" : ""}`);
  banner("인쇄: 현재 ‘전체 제품 데일리’ 시트를 선택하세요. ‘숫자 데이터’ 시트는 필터·검산용입니다.");
  const groupRow = sheet.rows.length + 1;
  const top: XlsxCell[] = [{ value: "제품", style: "Header", fontSize: 8, wrapText: true }];
  for (const group of DAILY_PRODUCT_GROUPS) {
    top.push({ value: group.label, style: "Header", fontSize: 8 }, { value: "", style: "Header", fontSize: 8 }, { value: "", style: "Header", fontSize: 8 });
    const start = top.length - 2;
    sheet.merges!.push({ fromRow: groupRow, toRow: groupRow, fromColumn: start, toColumn: start + 2 });
  }
  sheet.rows.push({ height: 22, cells: top });
  sheet.rows.push({ height: 28, cells: [{ value: "기준 제품명", style: "Header", fontSize: 8 }, ...DAILY_PRODUCT_GROUPS.flatMap(() =>
    DAILY_PRODUCT_METRICS.map(metric => ({ value: `${metric.label}\n(증감%)`, style: "Header" as const, fontSize: 8, wrapText: true })))] });
  const headerEnd = sheet.rows.length;
  sheet.freezeRow = headerEnd;
  const appendProduct = (row: DailyProductRow, isTotal: boolean) => {
    sheet.rows.push({ height: Math.max(30, Math.ceil(row.productName.length / 10) * 11), cells: [
      { value: row.productName, style: isTotal ? "TotalText" : "Text", fontSize: 8, wrapText: true },
      ...DAILY_PRODUCT_GROUPS.flatMap(group => DAILY_PRODUCT_METRICS.map(metric => reportCell(row.groups[group.key][metric.key], isTotal || group.key === "TOTAL")))
    ] });
  };
  report.rows.forEach(row => appendProduct(row, false));
  appendProduct(report.totals, true);
  banner("—는 미확인, 0은 확인된 0원입니다. *는 부분 금액, †는 추정 포함입니다. 전일 0·음수·자료 없음은 비율 대신 상태를 표시합니다.", 25);
  banner("전체 금액은 중복 제거된 통합 결과입니다. 플랫폼 표시 금액을 다시 합산하지 않습니다. 증감률은 전일 대비 변화이며 광고의 인과효과를 뜻하지 않습니다.", 25);
  for (const row of report.reconciliation) banner(`${row.label} · 당일 ${dailyProductMoney(row.current)} · 전일 ${dailyProductMoney(row.previous)}`, 22);
  for (const warning of report.warnings) banner(warning, 25);
  banner(`발행 기준: ${report.snapshotHash} · 작성 시각: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} 한국시간`, 22);
  sheet.print = { orientation: "landscape", paperSize: "A4", fitToWidth: 1, fitToHeight: 0,
    area: { fromRow: 1, toRow: sheet.rows.length, fromColumn: 1, toColumn: 16 }, repeatRows: { from: groupRow, to: headerEnd } };

  const numeric: XlsxWorkbookInput = { sheetName: "숫자 데이터", columns: Array.from({ length: 12 }, (_, index) => ({ width: index < 2 ? 26 : index === 10 ? 50 : 18 })), rows: [], freezeRow: 1, freezeColumn: 2,
    autoFilter: { fromRow: 1 } };
  numeric.rows.push(["제품키", "제품명", "그룹", "지표", "당일 금액", "전일 금액", "증감액", "증감률", "당일 상태", "전일 상태", "비교 사유", "추정 여부"].map(value => ({ value, style: "Header" })));
  const appendNumeric = (row: DailyProductRow, isTotal: boolean) => {
    for (const group of DAILY_PRODUCT_GROUPS) for (const metric of DAILY_PRODUCT_METRICS) {
      const value = row.groups[group.key][metric.key];
      const values = [numberCell(value.current.value, "Decimal"), numberCell(value.previous.value, "Decimal"), numberCell(value.change, "Decimal"), numberCell(value.changePct, "Percent1", true)];
      const precision = values.map((item, index) => item.text ? ["당일", "전일", "증감액", "증감률"][index] : "").filter(Boolean);
      const reason = [value.comparisonReason, ...value.current.reasonCodes, ...value.previous.reasonCodes,
        ...(precision.length ? [`${precision.join("·")}: 정밀도 보존을 위해 원본 문자열로 저장`] : [])].filter(Boolean).join(" · ");
      numeric.rows.push([
        { value: isTotal ? "__TOTAL__" : row.productKey, style: "Text" }, { value: row.productName, style: "Text" },
        { value: group.label, style: "Text" }, { value: metric.label, style: "Text" }, ...values.map(item => item.cell),
        { value: dailyProductStateLabel(value.current), style: "Text" }, { value: dailyProductStateLabel(value.previous), style: "Text" },
        { value: reason, style: "Text", wrapText: true }, { value: value.current.isEstimate || value.previous.isEstimate ? "추정 포함" : "", style: "Text" }
      ]);
    }
  };
  report.rows.forEach(row => appendNumeric(row, false));
  // Keep data filters exclusive to real products; totals and residuals follow a blank separator.
  numeric.autoFilter!.toRow = numeric.rows.length;
  numeric.rows.push([]);
  appendNumeric(report.totals, true);
  for (const residual of report.reconciliation) numeric.rows.push([
    { value: "__UNASSIGNED__", style: "Text" }, { value: residual.label, style: "Text" }, { value: "미귀속 조정", style: "Text" },
    { value: residual.key, style: "Text" }, numberCell(residual.current, "Decimal").cell, numberCell(residual.previous, "Decimal").cell
  ]);
  numeric.rows.push([{ value: `보고일 ${report.date} · 전일 ${report.previousDate} · ${report.scopeLabel} · 발행 기준 ${report.snapshotHash}`, style: "Text" }]);
  numeric.rows.push([{ value: "빈 숫자 셀은 미확인/제외이며 0원이 아닙니다. 정밀도 보존 문자열은 숫자 계산에서 제외될 수 있으므로 비교 사유를 확인하세요.", style: "Text" }]);
  return { sheets: [sheet, numeric], activeSheet: 0 };
}

export const buildDailyProductsXlsx = (report: DailyProductsReport) => buildXlsxWorkbook(buildDailyProductsXlsxInput(report));
export const dailyProductsXlsxFileName = (date: string) => `제품통합_데일리_전체제품_${date}.xlsx`;
