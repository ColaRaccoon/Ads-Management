import { Prisma } from "@prisma/client";
import { parseDateRange } from "../common/date-range";
import type { NativeResultAmount, NativeStoredResult } from "../unified-performance/native-result-contract";
import { buildCoupangNativeProductProfitRows, summarizeCoupangProductProfitRows } from "./coupang.service";

// Serialize the source's Number result without rounding it to the raw ledger's decimal scale.
const scalar = (value: number | null): string | null => value !== null && Number.isFinite(value) ? new Prisma.Decimal(value).toFixed() : null;
const amount = (known: number | null, complete: number | null = known): NativeResultAmount => ({ known: scalar(known), complete: scalar(complete) });

/** Called during publication in the adapter's RR transaction, never from unified report GETs. */
export async function readCoupangNativeDailyResults(client: Prisma.TransactionClient, date: string): Promise<NativeStoredResult[]> {
  let sourceUpdatedAt: string | null = null;
  const rows = await buildCoupangNativeProductProfitRows(client, parseDateRange(date, date), value => { sourceUpdatedAt = value; });
  const summary = summarizeCoupangProductProfitRows(rows);
  const completeRows = rows.filter(row => row.calculationStatus === "COMPLETE" && Number.isFinite(row.marginKrw) && Number.isFinite(row.totalCostKrw));
  const completeBeforeAds = rows.length && summary.marginKrw !== null ? summary.marginKrw + summary.adSpendKrw : null;
  const results: NativeStoredResult[] = rows.map(row => ({
    kind: "PRODUCT", group: "COUPANG", productKey: `COUPANG:${row.productId}`, productName: row.productName,
    quantity: scalar(row.reportedSalesQuantity),
    // The native Daily Report displays reported gross sales, not adjusted actual net sales.
    revenue: amount(row.reportedSalesKrw), adSpend: amount(row.adSpendKrw),
    netProfit: amount(row.knownMarginKrw, row.marginKrw),
    profitBeforeAds: amount(row.marginKrw === null ? null : row.marginKrw + row.adSpendKrw),
    sourceUpdatedAt,
    issues: [...row.warnings, ...(row.calculationStatus === "INCOMPLETE" ? ["COUPANG_NATIVE_CALCULATION_INCOMPLETE"] : [])],
    audit: {
      reportedNetSalesKrw: scalar(row.reportedNetSalesKrw), actualNetSalesKrw: scalar(row.actualNetSalesKrw),
      actualSalesQuantity: scalar(row.actualSalesQuantity), cancelAmountKrw: scalar(row.cancelAmountKrw),
      manualPurchaseSalesKrw: scalar(row.manualPurchaseSalesKrw), manualPurchaseQuantity: scalar(row.manualPurchaseQuantity),
      manualPurchaseVendorFeeKrw: scalar(row.manualPurchaseVendorFeeKrw), calculationStatus: row.calculationStatus
    }
  }));
  results.unshift({
    kind: "SUMMARY", group: "COUPANG", productKey: "COUPANG:SUMMARY", productName: null,
    quantity: scalar(summary.reportedSalesQuantity), revenue: amount(summary.reportedSalesKrw), adSpend: amount(summary.adSpendKrw),
    netProfit: amount(summary.knownMarginKrw, rows.length ? summary.marginKrw : null),
    // A complete summary uses one native operation order for both representations.
    // For partial summaries, only COMPLETE products contribute to the known subtotal.
    profitBeforeAds: amount(completeBeforeAds ?? completeRows.reduce((total, row) => total + row.marginKrw! + row.adSpendKrw, 0), completeBeforeAds),
    sourceUpdatedAt,
    issues: [...new Set(results.flatMap(row => row.issues)), ...(!rows.length ? ["COUPANG_NO_NATIVE_SOURCE_ROWS"] : [])],
    audit: {
      reportedNetSalesKrw: scalar(summary.reportedNetSalesKrw), actualNetSalesKrw: scalar(summary.actualNetSalesKrw),
      cancelAmountKrw: scalar(summary.cancelAmountKrw), manualPurchaseSalesKrw: scalar(summary.manualPurchaseSalesKrw),
      manualPurchaseQuantity: scalar(summary.manualPurchaseQuantity), manualPurchaseVendorFeeKrw: scalar(summary.manualPurchaseVendorFeeKrw),
      incompleteProductCount: scalar(summary.incompleteProductCount), excludedNetSalesKrw: scalar(summary.excludedNetSalesKrw)
    }
  });
  return results;
}
