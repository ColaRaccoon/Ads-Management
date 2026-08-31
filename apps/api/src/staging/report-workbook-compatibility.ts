import ExcelJS from "exceljs";
import { businessCompatibilityDigest } from "./business-compatibility-contract";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_ROWS = 100_000;
const MAX_REPORT_CELLS = 1_000_000;
const EXPECTED_SHEETS = ["Summary", "Product Performance", "Adset Performance", "Decisions", "Unmatched", "Change Logs"];
const SUMMARY_LABELS = [
  "Period", "Report Type", "Spend USD", "Spend KRW", "Purchases", "CPA KRW",
  "Revenue KRW", "Margin KRW", "Unmatched", "Missing Cost Rules", "Missing CPA Rules"
];

export async function reportWorkbookCompatibility(
  bytes: Buffer,
  expected: { from: string; to: string; reportType: string; runId: string }
) {
  if (bytes.length < 1 || bytes.length > MAX_REPORT_BYTES) throw new Error("REPORT_COMPATIBILITY_SIZE_INVALID");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.map((sheet) => sheet.name).join("|") !== EXPECTED_SHEETS.join("|")) {
    throw new Error("REPORT_COMPATIBILITY_SHEETS_INVALID");
  }

  const summarySheet = workbook.getWorksheet("Summary")!;
  if (summarySheet.rowCount !== SUMMARY_LABELS.length) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  const summary = Object.fromEntries(SUMMARY_LABELS.map((label, index) => {
    const row = summarySheet.getRow(index + 1);
    if (primitive(row.getCell(1).value) !== label) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
    return [label, normalized(row.getCell(2).value, expected.runId)];
  }));
  if (summary.Period !== `${expected.from} ~ ${expected.to}` || summary["Report Type"] !== expected.reportType) {
    throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  }
  for (const label of SUMMARY_LABELS.slice(2)) {
    if (typeof summary[label] !== "number" || !Number.isFinite(summary[label])) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  }

  let cellCount = SUMMARY_LABELS.length * 2;
  const products = projectedRows(workbook.getWorksheet("Product Performance")!, [
    "product.code", "product.name", "product.displayName", "totals.spendUsd", "totals.spendKrw",
    "totals.purchaseCount", "totals.cpaKrw", "totals.revenueKrw", "totals.marginKrw"
  ], expected.runId);
  const adsets = projectedRows(workbook.getWorksheet("Adset Performance")!, [
    "adsetName", "stage", "product.displayName", "totals.spendUsd", "totals.spendKrw",
    "totals.purchaseCount", "totals.cpaKrw", "totals.revenueKrw", "totals.marginKrw"
  ], expected.runId);
  const decisions = projectedRows(workbook.getWorksheet("Decisions")!, [
    "scopeType", "decision", "severity", "reason", "recommendedAction"
  ], expected.runId);
  const unmatched = projectedRows(workbook.getWorksheet("Unmatched")!, [
    "metricDate", "adsetName", "spendUsd", "resultCount"
  ], expected.runId, true);
  const changeLogs = projectedRows(workbook.getWorksheet("Change Logs")!, [
    "actionDate", "actionType", "entityType", "reason"
  ], expected.runId, true);
  for (const rows of [products, adsets, decisions, unmatched, changeLogs]) {
    cellCount += rows.reduce((total, row) => total + Object.keys(row).length, 0);
  }
  if (cellCount > MAX_REPORT_CELLS) throw new Error("REPORT_COMPATIBILITY_CELL_LIMIT");
  if (!products.some((row) => row["product.displayName"] === "Compatibility product")) {
    throw new Error("REPORT_COMPATIBILITY_PRODUCT_MISSING");
  }
  if (!adsets.some((row) => row.adsetName === "Compatibility <RUN_ID>")) {
    throw new Error("REPORT_COMPATIBILITY_ADSET_MISSING");
  }
  if (decisions.length < 1) throw new Error("REPORT_COMPATIBILITY_DECISIONS_MISSING");
  return businessCompatibilityDigest({ summary, products, adsets, decisions, unmatched, changeLogs });
}

function projectedRows(
  sheet: ExcelJS.Worksheet,
  selectedColumns: string[],
  runId: string,
  allowEmpty = false
) {
  if (sheet.rowCount < 1 || sheet.rowCount > MAX_REPORT_ROWS) throw new Error("REPORT_COMPATIBILITY_ROW_LIMIT");
  if (primitive(sheet.getRow(1).getCell(1).value) === "No data") {
    if (!allowEmpty) throw new Error("REPORT_COMPATIBILITY_REQUIRED_ROWS_MISSING");
    return [];
  }
  const header = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    const value = primitive(cell.value);
    if (typeof value === "string") header.set(value, column);
  });
  for (const column of selectedColumns) if (!header.has(column)) throw new Error("REPORT_COMPATIBILITY_COLUMN_MISSING");
  const rows: Record<string, string | number | boolean | null>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(Object.fromEntries(selectedColumns.map((column) => [
      column,
      normalized(row.getCell(header.get(column)!).value, runId)
    ])));
  }
  return rows;
}

function primitive(value: ExcelJS.CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error("REPORT_COMPATIBILITY_CELL_INVALID");
}

function normalized(value: ExcelJS.CellValue, runId: string) {
  const result = primitive(value);
  return typeof result === "string" ? result.split(runId).join("<RUN_ID>") : result;
}
