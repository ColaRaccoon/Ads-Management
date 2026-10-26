import { MetaReportingMeasurement, validMetaReportingMeasurement } from "./meta-reporting-measurements";
export type MetaMcpNullBasicProjection={version:1;rule:"EXPLICIT_ZERO_CHILDREN_OF_NULL_BASIC_ADSETS";rawAdCount:number;selectedAdCount:number;excludedAdCount:number;excludedAdsetCount:number;excludedAdIdsFingerprint:string;excludedAdsetIdsFingerprint:string;proofFingerprint:string};
export function validNullBasicProjection(v:unknown):v is MetaMcpNullBasicProjection {if(!record(v)||Object.keys(v).sort().join()!=="excludedAdCount,excludedAdIdsFingerprint,excludedAdsetCount,excludedAdsetIdsFingerprint,proofFingerprint,rawAdCount,rule,selectedAdCount,version"||v.version!==1||v.rule!=="EXPLICIT_ZERO_CHILDREN_OF_NULL_BASIC_ADSETS")return false;return ["rawAdCount","selectedAdCount","excludedAdCount","excludedAdsetCount"].every(k=>Number.isInteger(v[k])&&(v[k] as number)>=0&&(v[k] as number)<=50000)&&(v.excludedAdCount as number)>0&&(v.excludedAdsetCount as number)>0&&(v.selectedAdCount as number)+(v.excludedAdCount as number)===v.rawAdCount&&["excludedAdIdsFingerprint","excludedAdsetIdsFingerprint","proofFingerprint"].every(k=>typeof v[k]==="string"&&/^[a-f0-9]{64}$/.test(v[k] as string));}
export type MetaMcpMeasurementEvidence = { policy:"REFERENCED_ADSETS_FROM_COMPLETE_WIRE";rawStatus:"COMPLETE_WIRE_UNVERIFIED_IDENTITY";rawIdentityVerified:false;
 captureSemanticFingerprint:string;selectionFingerprint:string;proofSemanticFingerprint:string|null;rawAdsetCount:number;selectedAdsetCount:number;excludedAdsetCount:number;
 excludedReason:"CURRENT_METADATA_ONLY_UNREFERENCED";linkClickBasis:"EXPLICIT_SCALAR"|"ZERO_FILTER_VERIFIED"|"DERIVED_ZERO_RESIDUAL";derivedZeroAdCount:number;knownLinkTotal:string;
 catalogSemanticFingerprint?:string;countSemantics?:"NONNEGATIVE_ADDITIVE_LINK_EVENTS";snapshotAtomic?:false;parentResidualsVerified?:true;derivedZeroCampaignCount?:number;derivedZeroAdsetCount?:number;nullBasicParentProjection?:MetaMcpNullBasicProjection };
export type MetaMcpPurchaseMeasurement = {
 countField:"omni_purchase";valueField:"omni_purchase_values";definition:"ATTRIBUTED_OMNI_PURCHASE_EVENTS";
 reportContext:"MCP_PROVIDER_DEFAULT_UNVERIFIED";snapshotAtomic:false;aliasesCombined:false;
 derivedZeroAdCount:number;proofSemanticFingerprint:string|null;catalogSemanticFingerprint:string;
 accountPurchaseCount:number;accountPurchaseValueUsd:string;adPurchaseValueUsd:string;selectedAdsetPurchaseValueUsd:string;parentMinusAdValueUsd:string;
 derivedZeroCampaignCount?:number;derivedZeroAdsetCount?:number;
 zeroValuePremise:"EMPTY_PURCHASE_EVENT_SUM";providerScalarZeroObserved:false;
};
/** Current accessible asset observations, never historical delivery/budget facts. */
export type MetaCurrentAsset = {
  status: string | null; effectiveStatus: string | null;
  dailyBudgetRaw: string | null; lifetimeBudgetRaw: string | null;
  startTime: string | null; endTime: string | null;
  dailyBudgetSourceUnit?: string | null; lifetimeBudgetSourceUnit?: string | null;
};
export type MetaCurrentMetadata = {
  scope: "CURRENT_ACCESSIBLE_ASSETS"; currencyCode: "USD";
  budgetUnit: "UNVERIFIED"; campaign: MetaCurrentAsset; adset: MetaCurrentAsset;
  ad: MetaCurrentAsset | null;
  sourceContext?: { transport: "MCP"; protocolVersion: "2025-06-18";
    actionReportTime: "MCP_PROVIDER_DEFAULT_UNVERIFIED"; budgetValueFormat: "PROVIDER_DECIMAL";measurementEvidence?:MetaMcpMeasurementEvidence;
    linkClickValueBasis?:"SOURCE_SCALAR"|"DERIVED_ZERO_RESIDUAL"|"DERIVED_ZERO_FILTER";rawLinkClickNull?:boolean;
    reportingMeasurement?:MetaReportingMeasurement;
    purchaseMeasurement?:MetaMcpPurchaseMeasurement;purchaseCountValueBasis?:"SOURCE_SCALAR"|"DERIVED_PURCHASE_ZERO_RESIDUAL";
    purchaseValueBasis?:"SOURCE_MONEY"|"DERIVED_ZERO_EMPTY_PURCHASE_EVENTS";rawPurchaseNull?:boolean };
};

export function currentDeliveryStatus(asset: MetaCurrentAsset): "active" | "inactive" | null {
  const status = asset.effectiveStatus;
  if (status === "ACTIVE") return "active";
  return status && ["PAUSED", "ARCHIVED", "DELETED", "CAMPAIGN_PAUSED", "ADSET_PAUSED",
    "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
    "PENDING_BILLING_INFO"].includes(status) ? "inactive" : null;
}

export function validCurrentMetadata(value: unknown): value is MetaCurrentMetadata {
  if (!record(value)) return false;
  const mcp = value.sourceContext !== undefined;
  if (Object.keys(value).sort().join() !== (mcp ? "ad,adset,budgetUnit,campaign,currencyCode,scope,sourceContext" : "ad,adset,budgetUnit,campaign,currencyCode,scope") ||
      value.scope !== "CURRENT_ACCESSIBLE_ASSETS" || value.currencyCode !== "USD" || value.budgetUnit !== "UNVERIFIED") return false;
  if (mcp && (!record(value.sourceContext) || Object.keys(value.sourceContext).sort().join() !== ["actionReportTime","budgetValueFormat","protocolVersion","transport",...(value.sourceContext.reportingMeasurement===undefined?[]:["reportingMeasurement"]),...(value.sourceContext.measurementEvidence===undefined?[]:["linkClickValueBasis","measurementEvidence","rawLinkClickNull"]),...(value.sourceContext.purchaseMeasurement===undefined?[]:["purchaseMeasurement","purchaseCountValueBasis","purchaseValueBasis","rawPurchaseNull"])].sort().join() ||
      value.sourceContext.transport !== "MCP" || value.sourceContext.protocolVersion !== "2025-06-18" ||
      value.sourceContext.actionReportTime !== "MCP_PROVIDER_DEFAULT_UNVERIFIED" || value.sourceContext.budgetValueFormat !== "PROVIDER_DECIMAL" ||
      (value.sourceContext.measurementEvidence!==undefined&&(!validMcpEvidence(value.sourceContext.measurementEvidence)||!validRowBasis(value.sourceContext))) ||
      (value.sourceContext.reportingMeasurement!==undefined&&(!validMetaReportingMeasurement(value.sourceContext.reportingMeasurement,value.ad!==null)||value.sourceContext.purchaseMeasurement===undefined)) ||
      (value.sourceContext.purchaseMeasurement!==undefined&&!validPurchaseContext(value.sourceContext,value.ad!==null)))) return false;
  if(mcp&&value.ad===null&&record(value.sourceContext)&&value.sourceContext.measurementEvidence!==undefined&&value.sourceContext.linkClickValueBasis!=="SOURCE_SCALAR"&&!(value.sourceContext.linkClickValueBasis==="DERIVED_ZERO_RESIDUAL"&&record(value.sourceContext.measurementEvidence)&&Number.isInteger(value.sourceContext.measurementEvidence.derivedZeroAdsetCount)&&(value.sourceContext.measurementEvidence.derivedZeroAdsetCount as number)>0))return false;
  return validAsset(value.campaign, mcp) && validAsset(value.adset, mcp) && (value.ad === null || validAsset(value.ad, mcp));
}
function validMcpEvidence(v:unknown):boolean{
 if(!record(v))return false;
 const base="captureSemanticFingerprint,derivedZeroAdCount,excludedAdsetCount,excludedReason,knownLinkTotal,linkClickBasis,policy,proofSemanticFingerprint,rawAdsetCount,rawIdentityVerified,rawStatus,selectedAdsetCount,selectionFingerprint";
 const parentFields=v.derivedZeroCampaignCount!==undefined||v.derivedZeroAdsetCount!==undefined?["derivedZeroCampaignCount","derivedZeroAdsetCount"]:[];
 if(parentFields.length&&(v.linkClickBasis!=="DERIVED_ZERO_RESIDUAL"||!parentFields.every(field=>Number.isInteger(v[field])&&(v[field] as number)>=0&&(v[field] as number)<=50000)||(v.derivedZeroCampaignCount as number)+(v.derivedZeroAdsetCount as number)===0))return false;
 const projectionFields=v.nullBasicParentProjection===undefined?[]:["nullBasicParentProjection"];
 if(projectionFields.length&&(!validNullBasicProjection(v.nullBasicParentProjection)||v.nullBasicParentProjection.excludedAdsetCount>(v.excludedAdsetCount as number)))return false;
 const keys=v.linkClickBasis==="DERIVED_ZERO_RESIDUAL"?[...base.split(","),"catalogSemanticFingerprint","countSemantics","snapshotAtomic","parentResidualsVerified",...parentFields,...projectionFields].sort().join():[...base.split(","),...projectionFields].sort().join();
 if(Object.keys(v).sort().join()!==keys||
 v.policy!=="REFERENCED_ADSETS_FROM_COMPLETE_WIRE"||v.rawStatus!=="COMPLETE_WIRE_UNVERIFIED_IDENTITY"||v.rawIdentityVerified!==false||v.excludedReason!=="CURRENT_METADATA_ONLY_UNREFERENCED")return false;
 if(!["captureSemanticFingerprint","selectionFingerprint"].every(k=>typeof v[k]==="string"&&/^[a-f0-9]{64}$(?![\s\S])/.test(v[k] as string))||
 !["rawAdsetCount","selectedAdsetCount","excludedAdsetCount","derivedZeroAdCount"].every(k=>Number.isInteger(v[k])&&(v[k] as number)>=0&&(v[k] as number)<=50000)||
 (v.selectedAdsetCount as number)+(v.excludedAdsetCount as number)!==v.rawAdsetCount||typeof v.knownLinkTotal!=="string"||!/^(0|[1-9]\d{0,18})$(?![\s\S])/.test(v.knownLinkTotal))return false;
 if(projectionFields.length&&v.linkClickBasis!=="DERIVED_ZERO_RESIDUAL")return false;
 if(v.linkClickBasis==="EXPLICIT_SCALAR")return v.derivedZeroAdCount===0&&v.proofSemanticFingerprint===null;
 const derived=((v.derivedZeroAdCount as number)>0||parentFields.length>0||projectionFields.length>0)&&typeof v.proofSemanticFingerprint==="string"&&/^[a-f0-9]{64}$(?![\s\S])/.test(v.proofSemanticFingerprint);
 return v.linkClickBasis==="ZERO_FILTER_VERIFIED"?derived:v.linkClickBasis==="DERIVED_ZERO_RESIDUAL"&&derived&&v.countSemantics==="NONNEGATIVE_ADDITIVE_LINK_EVENTS"&&v.snapshotAtomic===false&&v.parentResidualsVerified===true&&typeof v.catalogSemanticFingerprint==="string"&&/^[a-f0-9]{64}$(?![\s\S])/.test(v.catalogSemanticFingerprint);
}
function validRowBasis(v:Record<string,unknown>):boolean{
 if(!record(v.measurementEvidence)||typeof v.rawLinkClickNull!=="boolean")return false;
 return v.linkClickValueBasis==="SOURCE_SCALAR"?v.rawLinkClickNull===false:
 v.rawLinkClickNull===true&&(v.linkClickValueBasis==="DERIVED_ZERO_RESIDUAL"&&v.measurementEvidence.linkClickBasis==="DERIVED_ZERO_RESIDUAL"||v.linkClickValueBasis==="DERIVED_ZERO_FILTER"&&v.measurementEvidence.linkClickBasis==="ZERO_FILTER_VERIFIED");
}
function validPurchaseContext(v:Record<string,unknown>,isAd:boolean):boolean{
 const p=v.purchaseMeasurement;if(!record(p))return false;const parentFields=p.derivedZeroCampaignCount!==undefined||p.derivedZeroAdsetCount!==undefined?["derivedZeroCampaignCount","derivedZeroAdsetCount"]:[];
 if(Object.keys(p).sort().join()!==[..."accountPurchaseCount,accountPurchaseValueUsd,adPurchaseValueUsd,aliasesCombined,catalogSemanticFingerprint,countField,definition,derivedZeroAdCount,parentMinusAdValueUsd,proofSemanticFingerprint,providerScalarZeroObserved,reportContext,selectedAdsetPurchaseValueUsd,snapshotAtomic,valueField,zeroValuePremise".split(","),...parentFields].sort().join())return false;
 if(parentFields.length&&(!parentFields.every(field=>Number.isInteger(p[field])&&(p[field] as number)>=0&&(p[field] as number)<=50000)||(p.derivedZeroCampaignCount as number)+(p.derivedZeroAdsetCount as number)===0))return false;
 if(p.countField!=="omni_purchase"||p.valueField!=="omni_purchase_values"||p.definition!=="ATTRIBUTED_OMNI_PURCHASE_EVENTS"||p.reportContext!=="MCP_PROVIDER_DEFAULT_UNVERIFIED"||p.snapshotAtomic!==false||p.aliasesCombined!==false||p.zeroValuePremise!=="EMPTY_PURCHASE_EVENT_SUM"||p.providerScalarZeroObserved!==false)return false;
 if(!Number.isInteger(p.derivedZeroAdCount)||(p.derivedZeroAdCount as number)<0||(p.derivedZeroAdCount as number)>50000||!Number.isInteger(p.accountPurchaseCount)||(p.accountPurchaseCount as number)<0||(p.accountPurchaseCount as number)>2147483647||typeof p.catalogSemanticFingerprint!=="string"||!/^[a-f0-9]{64}$(?![\s\S])/.test(p.catalogSemanticFingerprint))return false;
 if((p.derivedZeroAdCount===0&&parentFields.length===0?p.proofSemanticFingerprint!==null:typeof p.proofSemanticFingerprint!=="string"||!/^[a-f0-9]{64}$(?![\s\S])/.test(p.proofSemanticFingerprint as string))||!["accountPurchaseValueUsd","adPurchaseValueUsd","selectedAdsetPurchaseValueUsd"].every(f=>typeof p[f]==="string"&&/^(0|[1-9]\d{0,9})\.\d{4}$(?![\s\S])/.test(p[f] as string))||typeof p.parentMinusAdValueUsd!=="string"||! /^-?(0|[1-9]\d{0,9})\.\d{4}$(?![\s\S])/.test(p.parentMinusAdValueUsd))return false;
 if(BigInt((p.accountPurchaseValueUsd as string).replace(".",""))-BigInt((p.adPurchaseValueUsd as string).replace(".",""))!==BigInt(p.parentMinusAdValueUsd.replace(".","")))return false;
 return v.rawPurchaseNull===false?v.purchaseCountValueBasis==="SOURCE_SCALAR"&&v.purchaseValueBasis==="SOURCE_MONEY":v.rawPurchaseNull===true&&(isAd?(p.derivedZeroAdCount as number)>0:(p.derivedZeroAdsetCount as number)>0)&&v.purchaseCountValueBasis==="DERIVED_PURCHASE_ZERO_RESIDUAL"&&v.purchaseValueBasis==="DERIVED_ZERO_EMPTY_PURCHASE_EVENTS";
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validAsset(value: unknown, mcp = false): boolean {
  if (!record(value) || Object.keys(value).sort().join() !== (mcp
    ? "dailyBudgetRaw,dailyBudgetSourceUnit,effectiveStatus,endTime,lifetimeBudgetRaw,lifetimeBudgetSourceUnit,startTime,status"
    : "dailyBudgetRaw,effectiveStatus,endTime,lifetimeBudgetRaw,startTime,status")) return false;
  if (mcp && !["daily", "lifetime"].every(prefix => {
    const raw = value[`${prefix}BudgetRaw`], unit = value[`${prefix}BudgetSourceUnit`];
    return raw === null ? unit === null : typeof unit === "string" && unit.length > 0 && unit.length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/.test(unit);
  })) return false;
  return ["status", "effectiveStatus"].every((field) => value[field] === null ||
    typeof value[field] === "string" && /^[A-Z][A-Z_]{0,63}$/.test(value[field] as string)) &&
    ["dailyBudgetRaw", "lifetimeBudgetRaw"].every((field) => value[field] === null ||
      typeof value[field] === "string" && (mcp ? /^(0|[1-9]\d{0,13})(\.\d{1,6})?$(?![\s\S])/ : /^(0|[1-9]\d{0,29})$/).test(value[field] as string)) &&
    ["startTime", "endTime"].every((field) => value[field] === null ||
      typeof value[field] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value[field] as string) &&
      validTimestamp(value[field] as string));
}
function validTimestamp(value: string): boolean {
  if (!Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day &&
    Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}

export function stableMetadataJson(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableMetadataJson(item))));
  if (record(value)) return JSON.stringify(Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, JSON.parse(stableMetadataJson(value[key]))])));
  return JSON.stringify(value);
}
