export type MetaVideoMetricTotals = {
  metricUnavailableReasons?: Record<string, string>;
  hasApiMetrics?: boolean; attributionContexts?: string[];
  reach: number | null;
  videoPlay3sCount: number | null;
  videoPlay25Count: number | null;
  videoPlay50Count: number | null;
  videoPlay75Count: number | null;
  videoPlay100Count: number | null;
  videoPlay3sRatePct: number | null;
  videoPlay25RatePct: number | null;
  videoPlay50RatePct: number | null;
  videoPlay75RatePct: number | null;
  videoPlay100RatePct: number | null;
};

export type MetaCreativeMetricTotals = MetaVideoMetricTotals & {
  providerPurchaseCount?:number|null;providerPurchaseValueUsd?:number|null;providerPurchaseRoas?:number|null;providerPurchaseCpaUsd?:number|null;
  providerPurchaseContext?:string|null;providerPurchaseDerivedZeroCount?:number|null;
  spendUsd: number;
  spendKrw: number | null;
  purchaseCount: number | null;
  cpaUsd: number | null;
  cpaKrw: number | null;
  ctrLinkPct: number | null;
  cpmUsd: number | null;
  roas: number | null;
  revenueKrw: number | null;
  marginKrw: number | null;
};

export type MetaCreativePerformanceRow = {
  creativeKey: string;
  displayName: string;
  productName: string | null;
  productId: string | null;
  materialNo: string | null;
  deliveryStatus: string | null;
  currentMetadataObservations?: MetaCurrentMetadataObservation[];
  totals: MetaCreativeMetricTotals;
  dataDays: number;
};

export type MetaCurrentAsset = {
  status: string | null; effectiveStatus: string | null;
  dailyBudgetRaw: string | null; lifetimeBudgetRaw: string | null;
  startTime: string | null; endTime: string | null;
  dailyBudgetSourceUnit?: string | null; lifetimeBudgetSourceUnit?: string | null;
};
export type MetaCurrentMetadata = {
  scope: "CURRENT_ACCESSIBLE_ASSETS"; currencyCode: "USD"; budgetUnit: "UNVERIFIED";
  campaign: MetaCurrentAsset; adset: MetaCurrentAsset; ad: MetaCurrentAsset | null;
  sourceContext?: { transport: "MCP"; protocolVersion: "2025-06-18";
    actionReportTime: "MCP_PROVIDER_DEFAULT_UNVERIFIED"; budgetValueFormat: "PROVIDER_DECIMAL";
    measurementEvidence?:{policy:"REFERENCED_ADSETS_FROM_COMPLETE_WIRE";rawStatus:"COMPLETE_WIRE_UNVERIFIED_IDENTITY";rawIdentityVerified:false;
      captureSemanticFingerprint:string;selectionFingerprint:string;proofSemanticFingerprint:string|null;rawAdsetCount:number;selectedAdsetCount:number;excludedAdsetCount:number;
      excludedReason:"CURRENT_METADATA_ONLY_UNREFERENCED";linkClickBasis:"EXPLICIT_SCALAR"|"ZERO_FILTER_VERIFIED"|"DERIVED_ZERO_RESIDUAL";derivedZeroAdCount:number;knownLinkTotal:string;
      catalogSemanticFingerprint?:string;countSemantics?:"NONNEGATIVE_ADDITIVE_LINK_EVENTS";snapshotAtomic?:false;parentResidualsVerified?:true};
    linkClickValueBasis?:"SOURCE_SCALAR"|"DERIVED_ZERO_RESIDUAL"|"DERIVED_ZERO_FILTER";rawLinkClickNull?:boolean;
    purchaseMeasurement?:{countField:"omni_purchase";valueField:"omni_purchase_values";definition:"ATTRIBUTED_OMNI_PURCHASE_EVENTS";reportContext:"MCP_PROVIDER_DEFAULT_UNVERIFIED";snapshotAtomic:false;aliasesCombined:false;derivedZeroAdCount:number;proofSemanticFingerprint:string|null;catalogSemanticFingerprint:string;accountPurchaseCount:number;accountPurchaseValueUsd:string;adPurchaseValueUsd:string;selectedAdsetPurchaseValueUsd:string;parentMinusAdValueUsd:string;zeroValuePremise:"EMPTY_PURCHASE_EVENT_SUM";providerScalarZeroObserved:false};
    purchaseCountValueBasis?:"SOURCE_SCALAR"|"DERIVED_PURCHASE_ZERO_RESIDUAL";purchaseValueBasis?:"SOURCE_MONEY"|"DERIVED_ZERO_EMPTY_PURCHASE_EVENTS";rawPurchaseNull?:boolean };
};
export type MetaCurrentMetadataObservation = {
  adId?: string | null; adsetId?: string | null;
  currentMetadata: MetaCurrentMetadata; metadataObservedAt: string;
};

export type MetaVideoRateKey =
  | "videoPlay3sRatePct"
  | "videoPlay25RatePct"
  | "videoPlay50RatePct"
  | "videoPlay75RatePct"
  | "videoPlay100RatePct";

export type MetaProductListItem = {
  id: string;
  code: string;
  name: string;
  displayName: string | null;
  isActive: boolean;
};

export type MetaCreativeVideoTrendPoint = {
  date: string;
  metricUnavailableReasons?: Record<string, string>;
  reach: number | null;
  cpmUsd: number | null;
  cpcLinkUsd: number | null;
  ctrLinkPct: number | null;
  addToCartRatePct: number | null;
  videoPlay3sRatePct: number | null;
  videoPlay25RatePct: number | null;
  videoPlay50RatePct: number | null;
  videoPlay75RatePct: number | null;
  videoPlay100RatePct: number | null;
};

export type MetaCreativeVideoTrendSeries = {
  creativeKey: string;
  displayName: string;
  productName: string | null;
  materialNo: string | null;
  deliveryStatus: string | null;
  originalAdNames: string[];
  dataDays: number;
  points: MetaCreativeVideoTrendPoint[];
};

export type MetaCreativeVideoTrendResponse = {
  productId: string;
  period: {
    from: string;
    to: string;
    selectedDays: number;
    dataDays: number;
  };
  creatives: MetaCreativeVideoTrendSeries[];
};

export type MetaCreativeTrendMetricKey =
  | "reach"
  | "cpmUsd"
  | "cpcLinkUsd"
  | "ctrLinkPct"
  | "addToCartRatePct"
  | MetaVideoRateKey;
