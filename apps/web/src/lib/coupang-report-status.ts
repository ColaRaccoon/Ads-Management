import { coupangProfitWarningLabel } from "./coupang-profit-warning";

export type CoupangCalculationPartStatus = "COMPLETE" | "INCOMPLETE" | "NOT_APPLICABLE";

type CalculationPartStatusRow = {
  normalCalculationStatus: CoupangCalculationPartStatus;
  manualCalculationStatus: CoupangCalculationPartStatus;
};

export function summarizeCoupangCalculationPartStatuses(rows: CalculationPartStatusRow[]) {
  return {
    normalCalculationStatus: aggregateCalculationPartStatus(rows.map((row) => row.normalCalculationStatus)),
    manualCalculationStatus: aggregateCalculationPartStatus(rows.map((row) => row.manualCalculationStatus))
  };
}

export function formatCoupangDailySummaryExportStatus(input: {
  isComplete: boolean;
  incompleteProductCount: number;
  excludedNetSalesKrw: number;
  excludedSalesQuantity: number;
  normalCalculationStatus: CoupangCalculationPartStatus;
  manualCalculationStatus: CoupangCalculationPartStatus;
}) {
  const partStatuses = `NORMAL:${input.normalCalculationStatus} | MANUAL:${input.manualCalculationStatus}`;
  return input.isComplete
    ? `COMPLETE | ${partStatuses}`
    : `PARTIAL | ${partStatuses} | excludedProducts=${input.incompleteProductCount} | excludedNetSalesKrw=${input.excludedNetSalesKrw} | excludedSalesQuantity=${input.excludedSalesQuantity}`;
}

export function formatCoupangDailyRowStatus(input: {
  exportStatus?: string;
  calculationStatus: "COMPLETE" | "INCOMPLETE";
  normalCalculationStatus: CoupangCalculationPartStatus;
  manualCalculationStatus: CoupangCalculationPartStatus;
  incompleteProductNames: string[];
  warnings: string[];
}) {
  if (input.exportStatus) return input.exportStatus;
  return [
    input.calculationStatus,
    `NORMAL:${input.normalCalculationStatus}`,
    `MANUAL:${input.manualCalculationStatus}`,
    ...(input.incompleteProductNames.length > 0 ? [`INCOMPLETE_PRODUCTS:${input.incompleteProductNames.join(", ")}`] : []),
    ...input.warnings.map(coupangProfitWarningLabel)
  ].join(" | ");
}

function aggregateCalculationPartStatus(statuses: CoupangCalculationPartStatus[]): CoupangCalculationPartStatus {
  if (statuses.some((status) => status === "INCOMPLETE")) return "INCOMPLETE";
  if (statuses.some((status) => status === "COMPLETE")) return "COMPLETE";
  return "NOT_APPLICABLE";
}
