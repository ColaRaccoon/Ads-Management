export type GoogleOptions = {
  enabled: boolean;
  connections: Array<{ id: string; provider: string; displayName: string; externalAccountId: string; currencyCode: string | null; timeZone: string | null }>;
  products: Array<{ id: string; displayName: string }>;
};

export type GoogleMappingKind = "CAMPAIGN" | "SALE";
export type GoogleSaleConfiguration = {
  optionScope?: "EXACT" | "PRODUCT";
  saleUnitLabel?: string | null;
  salePriceKrwOverride?: number | null;
  productCostKrwOverride?: number | null;
  shippingKrwOverride?: number | null;
  extraCostKrwOverride?: number | null;
};
export type GoogleMappingDraft = GoogleSaleConfiguration & {
  kind: GoogleMappingKind;
  id?: string;
  connectionId: string;
  campaignId?: string;
  productNo?: string;
  optionName?: string;
  productId: string | null;
  startDate: string;
  endDate: string | null;
  expectedUpdatedAt?: string;
};
export type GoogleMapping = Omit<GoogleMappingDraft, "campaignId" | "productNo"> & { id: string; updatedAt: string; campaignId: string | null; productNo: string | null; productName: string | null };
export type GoogleMappings = {
  campaignMappings: GoogleMapping[];
  salesMappings: GoogleMapping[];
  audit: Array<{ id: string; createdAt: string; actorUserId: string; before: unknown; after: unknown }>;
  pagination: { page: number; pageSize: number; total: number };
};
export type GoogleMappingPreview = {
  before: GoogleMapping | null;
  after: GoogleMappingDraft;
  affectedRange: { from: string; to: string | null };
  overlaps: Array<{ id: string }>;
  canSave: boolean;
};

export type GoogleProfitRow = {
  productId: string | null; date: string; quantity: number; lineCount: number;
  saleUnitLabel?: string | null; saleUnitLabels?: string[];
  revenueKrw: number | null; knownRevenueKrw: number; collectedRevenueKrw: number | null;
  grossCostKrw: number | null; couponDeductionKrw: number | null;
  adSpendKrw: number | null; adSpendKrwExact: string | null; knownAdSpendKrw: number;
  marginKrw: number | null; calculatedMarginKrw: number | null; marginRate: number | null; roas: number | null;
  priceMismatchCount: number; complete: boolean; warningCodes: string[];
};
export type GoogleCampaignRow = {
  connectionId: string; customerId: string; campaignId: string; campaignName: string;
  currencyCode: string; productIds: string[]; hasUnmapped: boolean; costMicros: string;
  adSpendKrw: number | null; adSpendKrwExact: string | null;
  impressions: number; clicks: number; ctr: number | null; cpcKrw: number | null; warningCodes: string[];
};
export type GoogleReportResponse = {
  range: { from: string; to: string };
  summary: GoogleProfitRow & { calculatedProductsMarginKrw: number; allocatedAdSpendKrw: number | null; unallocatedAdSpendKrw: number | null; unmappedSalesCount: number };
  products: GoogleProfitRow[]; daily: GoogleProfitRow[]; campaigns: GoogleCampaignRow[];
  unmappedSales: Array<{ id: string; date: string; connectionId: string | null; orderNo: string; productName: string | null; productNo: string | null; optionName: string | null; quantity: number; collectedRevenueKrw: number | null }>;
  completeness: { complete: boolean; missingGoogleDates: string[]; missingCafe24Dates: string[]; completeDates: string[]; warningCodes: string[] };
  reconciliation: { collectedAdSpendKrwExact: string | null; allocatedAdSpendKrwExact: string | null; unallocatedAdSpendKrwExact: string | null; balanced: boolean; byCurrency: Array<{ currencyCode: string; collectedCostMicros: string; allocatedCostMicros: string; unallocatedCostMicros: string; balanced: boolean }> };
  pagination: { page: number; pageSize: number; total: number };
  coverage: Array<{ connectionId: string; provider: string; date: string; selectedSource: string | null; complete: boolean; state: string; rowCount: number | null; amount: string | null; lastSuccessAt: string | null; lastAttemptAt: string | null; warningCodes: string[] }>;
  notices: string[];
};
