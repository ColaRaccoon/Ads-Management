/** Internal adapter contract. Never return SourceRef or name snapshots in public summaries. */
export const CONTRACT_VERSION = "product-performance-v1.1.0";
export const PLATFORMS = ["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"] as const;
export type Platform = typeof PLATFORMS[number];
export type DecimalString = string;
export type BusinessDate = string;
export type Marketplace = "CAFE24" | "COUPANG" | "NAVER_SMARTSTORE";
export type AdMedium = "META" | "GOOGLE" | "NAVER_DA" | "COUPANG_ADS";
export type ComponentKind = "SALE" | "AD_SPEND" | "DIRECT_COST" | "COMMON_EXPENSE";
export type Participation = "INCLUDED" | "NOT_APPLICABLE" | "EXCLUDED_BY_USER";
export type CollectionState = "COMPLETE" | "PARTIAL" | "NOT_COLLECTED" | "STALE" | "MAPPING_REQUIRED";
export type MatchStatus = "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "NAME_MISSING" | "UNIT_REQUIRED";
export interface Quality {
  isEstimate: boolean;
  confidence: "SOURCE_REPORTED" | "ESTIMATED";
  issues: string[];
}
export interface AmountQuality extends Quality {
  knownAmount: DecimalString | null;
  completeAmount: DecimalString | null;
  knownComponentCount: number;
  expectedComponentCount: number;
}
export interface NameEvidence {
  originalName: string;
  originalOption: string;
  nameField: string;
  restorationPath: string | null;
  normalizedName: string;
  normalizedOption: string;
  canonicalProductName: string | null;
  saleUnitName: string | null;
  matchStatus: MatchStatus;
  candidateNames: string[];
  ruleIds: string[];
  nameRuleVersion: string;
  nameInputHash: string;
}
export interface SourceRef {
  sourceSystem: string;
  platform: Platform;
  schema: string;
  table: string;
  scopeKey: string;
  recordKind: string;
  sourceRecordKey: string;
  selectedSource: string;
  sourceVersion: string;
  uploadOrRunId: string | null;
  payloadHash: string | null;
  providerUpdatedAt: string | null;
  observedAt: string;
  businessDate: BusinessDate;
  dateBasis: string;
  sourceTimeZone: string;
}
export interface RuleVersions {
  scopePolicyVersion: string;
  nameRuleVersion: string;
  saleUnitRuleVersion: string;
  allocationRuleVersion: string;
  calculationVersion: string;
  fxVersion: string;
}
export interface FxEvidence {
  baseCurrency: string;
  quoteCurrency: string;
  requestedDate: BusinessDate;
  sourceDate: BusinessDate | null;
  rate: DecimalString | null;
  provider: string | null;
  fallbackType: string;
  fxVersion: string;
}
export interface SaleQuantity {
  saleUnitName: string | null;
  optionName: string | null;
  orderedQuantity: DecimalString;
  calculationQuantity: DecimalString;
  unitsPerSaleUnit: DecimalString | null;
  physicalQuantity: DecimalString | null;
  quantityBasis: string;
}
export interface CostComponent {
  kind: string;
  sourceExpenseKey: string;
  amount: DecimalString | null;
  includedInRevenue: boolean;
  applied: boolean;
}
export interface SaleFact extends SaleQuantity {
  ref: SourceRef;
  name: NameEvidence;
  productName: string | null;
  marketplace: Marketplace;
  operatingRevenue: DecimalString | null;
  revenueBasis: "REGISTERED_SALE_PRICE" | "PRODUCT_PAYMENT_AMOUNT" | "NET_SALES_REPORTED";
  collectedPaymentAmount: DecimalString | null;
  paymentGrain: string;
  paymentAllocationStatus: string;
  discountTreatment: string;
  refundTreatment: string;
  productCost: DecimalString | null;
  platformFee: DecimalString | null;
  directShippingCost: DecimalString | null;
  returnCost: DecimalString | null;
  otherDirectCost: DecimalString | null;
  vatExpense: DecimalString | null;
  discountNotYetIncluded: DecimalString | null;
  manualVendorFee: DecimalString | null;
  costRuleRef: string | null;
  costEffectiveFrom: BusinessDate | null;
  costEffectiveTo: BusinessDate | null;
  costBasisVersion: string;
  taxPolicyVersion: string;
  feeBasis: string;
  feePresenceMask: string;
  shippingBasis: string;
  dateBasis: string;
  costComponents: CostComponent[];
  profitBeforeAds: DecimalString | null;
  quality: Quality;
}
export interface AdSpendFact {
  ref: SourceRef;
  name: NameEvidence;
  productName: string | null;
  medium: AdMedium;
  originalAmount: DecimalString;
  currency: string;
  fx: FxEvidence;
  amountKrw: DecimalString | null;
  roundingAdjustment: DecimalString;
  preQuantizationFingerprint: string;
  attribution: "DIRECT" | "ALLOCATED" | "UNALLOCATED";
  allocationRuleVersion: string;
  referenceConversionRevenue: DecimalString | null;
  quality: Quality;
}
export interface CommonExpenseFact {
  ref: SourceRef;
  expenseKey: string;
  kind: "SHIPPING_INCOME" | "SHIPPING_COST" | "FAKE_PURCHASE" | "OTHER";
  amountKrw: DecimalString | null;
  scopeKey: string;
  productName: string | null;
  allocationStatus: "DIRECT" | "ALLOCATED" | "UNALLOCATED";
  allocationRuleVersion: string;
  originalAmount: DecimalString;
  unallocatedAmount: DecimalString | null;
  quality: Quality;
}
export interface SourceCoverage {
  sourceSystem: string;
  platform: Platform;
  component: ComponentKind;
  scopeKey: string;
  date: BusinessDate;
  participation: Participation;
  collectionState: CollectionState;
  rowsPresent: number;
  zeroConfirmed: boolean;
  selectedSource: string | null;
  selectedUploadId: string | null;
  sourceVersion: string | null;
  collectedAt: string | null;
  sourceAsOf: string | null;
  calculatedAt: string | null;
  lastSuccessAt: string | null;
  sourceFingerprint: string | null;
  nameRuleVersion: string;
  costRuleVersion: string;
  mappedRows: number;
  unmappedRows: number;
  unmatchedAmount: DecimalString | null;
  missingCostRows: number;
  missingFxAmount: DecimalString | null;
  unallocatedAmount: DecimalString | null;
  quality: Quality;
}
export interface ControlTotal {
  /** Absent in v1.1.0 sources means the platform's primary amount. Additive stage03 dimension. */
  measure?: "AD_SPEND" | "OPERATING_REVENUE" | "REGISTERED_GROSS" | "SOURCE_LIST_PRICE_GROSS" | "PRODUCT_COST" | "DIRECT_SHIPPING_COST" | "OTHER_DIRECT_COST" | "VAT_EXPENSE" | "COUPON";
  sourceSystem: string;
  platform: Platform;
  scopeKey: string;
  date: BusinessDate;
  currency: string;
  selectedRows: number;
  selectedAmount: DecimalString | null;
  assignedAmount: DecimalString | null;
  unmatchedAmount: DecimalString | null;
  unallocatedAmount: DecimalString | null;
  excludedNonSaleAmount: DecimalString | null;
  excludedByPolicyRows: number;
  roundingAdjustment: DecimalString;
  difference: DecimalString | null;
}
export interface AdapterRequest extends RuleVersions {
  contractVersion: string;
  runId: string;
  readSnapshotId: string;
  from: BusinessDate;
  to: BusinessDate;
  scopeKeys: string[];
  platforms: Platform[];
  sourcePolicySnapshot: Record<string, unknown>;
  sourceWatermarks: Record<string, string | null>;
  cursor: string | null;
  limit: number;
}
export interface AdapterBatch {
  sales: SaleFact[];
  adSpends: AdSpendFact[];
  commonExpenses: CommonExpenseFact[];
  coverage: SourceCoverage[];
  sourceControlTotals: ControlTotal[];
  nextCursor: string | null;
  sourceFingerprint: string | null;
}
/** Selection/authorization happens before any source read. Adapters cannot publish. */
export interface SourceAdapter {
  readonly platform: Platform;
  read(request: Readonly<AdapterRequest>): Promise<AdapterBatch>;
}
/** 06 owns the implementation; one complete source/scope/day revision is the publish boundary. */
export interface AggregationRepository {
  stage(request: AdapterRequest, batch: AdapterBatch): Promise<void>;
  publishSourceDay(runId: string, expectedPreviousRunId: string | null): Promise<void>;
  fail(runId: string, issue: string): Promise<void>;
}
