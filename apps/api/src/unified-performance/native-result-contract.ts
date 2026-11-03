/** Financial amounts are completed by the source producer, never reconstructed by a report GET. */
export type NativeResultAmount = { known: string | null; complete: string | null };
export type NativeResultGroup = "STOREFRONT" | "GOOGLE" | "NAVER" | "COUPANG";
export type NativeOptionAmounts = Pick<NativeStoredResult, "quantity" | "revenue" | "adSpend" | "netProfit" | "profitBeforeAds">;
export type NativeStoredOption = NativeOptionAmounts & { key: string; name: string };
export interface NativeStoredResult {
  kind: "SUMMARY" | "PRODUCT";
  group: NativeResultGroup;
  productKey: string;
  productName: string | null;
  quantity: string | null;
  revenue: NativeResultAmount;
  adSpend: NativeResultAmount;
  netProfit: NativeResultAmount;
  profitBeforeAds: NativeResultAmount;
  sourceUpdatedAt: string | null;
  issues: string[];
  audit?: Record<string, string | null>;
  /** Source-completed option amounts, never additional top-level revenue. */
  sourceOptions?: NativeStoredOption[];
  optionBasis?: NativeOptionAmounts;
}
export const NATIVE_RESULT_VERSION = "source-final-results-v1";
