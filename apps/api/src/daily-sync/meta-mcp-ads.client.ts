import { META_REPORTING_FIELDS, metaReportingFields, MetaReportingMeasurement } from "../domain/meta-reporting-measurements";
import { markMetaFailureStage } from "./meta-failure-diagnostic";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Prisma } from "@prisma/client";
import { MetaCurrentAsset, MetaCurrentMetadata, MetaMcpMeasurementEvidence, MetaMcpPurchaseMeasurement, currentDeliveryStatus, stableMetadataJson, validCurrentMetadata } from "../domain/meta-current-metadata";
import { CreativeNameParser } from "../domain/creative-name-parser";
import type { MetaApiAd, MetaApiAdset } from "./canonical-api-writer.service";
import { MetaDayReader, MetaDayReadInput } from "./meta-day-reader";
import type { MetaDaySnapshot } from "./meta-ads.client";
import { boundedMetaMcpEnvelope } from "./meta-mcp-envelope";
import { META_MCP_DAY_FIELDS, MetaMcpLevel, MetaMcpMoney, MetaMcpWireReader, MetaMcpWireSnapshot, validateMetaMcpCatalog, validateMetaMcpWireRow } from "./meta-mcp-wire-reader";
import { ProviderFailure } from "./bounded-request";
import { parseIsoDate } from "./sync-contract";
import { assertMetaOperatingGate } from "./meta-operating-gate";
import { selectMetaMcpDay } from "./meta-mcp-capture";
import { validateMetaMcpZeroProof } from "./meta-mcp-zero-proof";
import { createMetaMcpResidualProof, validateMetaMcpResidualProof, metaMcpResidualLinkView, metaMcpNeedsLinkProof } from "./meta-mcp-residual-proof";
import {convertMetaMcpPurchaseObservation,createMetaMcpPurchaseResidualProof,validateMetaMcpPurchaseResidualProof,metaMcpPurchaseValue} from "./meta-mcp-purchase";

type Json = Record<string, unknown>;
const LEVELS: MetaMcpLevel[] = ["ad", "adset", "campaign", "ad_account"];
const CONTEXT = "MCP_PROVIDER_DEFAULT_UNVERIFIED" as const;
function fail(code = "FIELD_UNSUPPORTED"): never { throw new ProviderFailure(code, false); }
const object = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v: unknown) => createHash("sha256").update(stableMetadataJson(v)).digest("hex");
function integer(value: unknown, big = false): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$(?![\s\S])/.test(value) ||
      BigInt(value) > (big ? 9_223_372_036_854_775_807n : 2_147_483_647n)) fail();
  return value;
}
function fixedDecimal(value: unknown, precision: number, scale: number): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,13})(\.\d{1,12})?$(?![\s\S])/.test(value)) fail();
  const decimal = new Prisma.Decimal(value);
  if (decimal.decimalPlaces() > scale || decimal.gte(new Prisma.Decimal(10).pow(precision-scale))) fail();
  return decimal.toFixed(scale);
}
function spend(row: Json): string {
  if (!object(row.amount_spent) || row.amount_spent.unit !== "USD") fail("CURRENCY_MISMATCH");
  return fixedDecimal(row.amount_spent.value,14,4);
}

/** Rechecks a complete protected capture; no flags can replace row/query identity validation. */
export function validateMetaMcpSnapshot(value: unknown): MetaMcpWireSnapshot {
  if (!object(value) || value.version !== 1 || value.transport !== "META_ADS_MCP" || value.status !== "COMPLETE_WIRE_ONLY" ||
      typeof value.accountId !== "string" || !/^\d{1,30}$(?![\s\S])/.test(value.accountId) || typeof value.day !== "string" ||
      typeof value.clientConversationId !== "string" || !/^[A-Za-z0-9]{20}$(?![\s\S])/.test(value.clientConversationId) ||
      !/[A-Z]/.test(value.clientConversationId) || !/[a-z]/.test(value.clientConversationId) || !/[0-9]/.test(value.clientConversationId) ||
      typeof value.observedAtUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(value.observedAtUtc) ||
      !Number.isFinite(Date.parse(value.observedAtUtc)) || new Date(value.observedAtUtc).toISOString() !== value.observedAtUtc ||
      Date.parse(value.observedAtUtc) > Date.now()+300000 || !Number.isInteger(value.pageCount) || (value.pageCount as number)<4 || (value.pageCount as number)>100 ||
      !Number.isInteger(value.byteCount) || (value.byteCount as number)<1 || (value.byteCount as number)>16*1024*1024 ||
      !object(value.levels) || !object(value.queries) || !Array.isArray(value.moneyUnits) ||
      ["paginationComplete","datesVerified","identityVerified"].some(k=>value[k]!==true) ||
      ["currencyVerified","attributionVerified","metricsNormalized","productionReady"].some(k=>value[k]!==false)) fail();
  parseIsoDate(value.day);
  if (Object.keys(value.levels).sort().join() !== [...LEVELS].sort().join() || Object.keys(value.queries).sort().join() !== [...LEVELS].sort().join()) fail();
  const levels = {} as Record<MetaMcpLevel, Json[]>; let rows = 0;
  for (const level of LEVELS) {
    const query = { ad_account_id:value.accountId, fields:[...META_MCP_DAY_FIELDS[level]], level,
      time_range:JSON.stringify({since:value.day,until:value.day}), time_increment:"1",object_state:"live",include_additional_context:false,client_conversation_id:value.clientConversationId,limit:1000 };
    if (stableMetadataJson(value.queries[level]) !== stableMetadataJson(query) || !Array.isArray(value.levels[level]) || value.levels[level].length > 50000-rows) fail();
    const seen = new Set<string>();
    levels[level] = (value.levels[level] as unknown[]).map(raw=> {
      if (!object(raw) || Object.keys(raw).some(k=>![...META_MCP_DAY_FIELDS[level],"date_start","date_stop"].includes(k))) fail();
      const checked = validateMetaMcpWireRow(raw,level,value.accountId as string,value.day as string);
      if (stableMetadataJson(checked)!==stableMetadataJson(raw) || seen.has(checked.id as string)) fail("RECONCILIATION_FAILED");
      seen.add(checked.id as string); return checked;
    });
    rows += levels[level].length;
  }
  if (rows > 50000 || levels.ad_account.length!==1) fail("RECONCILIATION_FAILED");
  const units=[...new Set(LEVELS.flatMap(l=>levels[l].map(r=>(r.amount_spent as MetaMcpMoney).unit)))].sort();
  if (stableMetadataJson(units)!==stableMetadataJson(value.moneyUnits)) fail("CURRENCY_MISMATCH");
  return {...value,levels} as MetaMcpWireSnapshot;
}
function metadata(campaign: Json, adset: Json, ad: Json | null, evidence?:MetaMcpMeasurementEvidence,rawLinkNull=false): MetaCurrentMetadata {
  const asset=(row: Json, campaignLevel=false): MetaCurrentAsset => {
    const daily=row.daily_budget as MetaMcpMoney|null|undefined,lifetime=row.lifetime_budget as MetaMcpMoney|null|undefined;
    return {status:row.status as string??null,effectiveStatus:row.effective_status as string??null,
      dailyBudgetRaw:daily?.value??null,dailyBudgetSourceUnit:daily?.unit??null,lifetimeBudgetRaw:lifetime?.value??null,lifetimeBudgetSourceUnit:lifetime?.unit??null,
      startTime:row.start_time as string??null,endTime:(campaignLevel?row.stop_time:row.end_time) as string??null};
  };
  const value: MetaCurrentMetadata={scope:"CURRENT_ACCESSIBLE_ASSETS",currencyCode:"USD",budgetUnit:"UNVERIFIED",
    campaign:asset(campaign,true),adset:asset(adset),ad:ad?asset(ad):null,
    sourceContext:{transport:"MCP",protocolVersion:"2025-06-18",actionReportTime:CONTEXT,budgetValueFormat:"PROVIDER_DECIMAL",...(evidence?{measurementEvidence:evidence,rawLinkClickNull:rawLinkNull,
      linkClickValueBasis:rawLinkNull?(evidence.linkClickBasis==="DERIVED_ZERO_RESIDUAL"?"DERIVED_ZERO_RESIDUAL" as const:"DERIVED_ZERO_FILTER" as const):"SOURCE_SCALAR" as const}:{})}};
  if (!validCurrentMetadata(value)) fail(); return value;
}
function common(row: Json) {
  return {spendUsd:spend(row),impressions:integer(row.impressions,true),inlineLinkClicks:Number(integer(row.link_click)),
    reach:Number(integer(row.reach)),clicksAll:Number(integer(row.clicks)),frequency:fixedDecimal(row.frequency,12,6),
    actionReportTime:CONTEXT,attributionWindows:[],attributionSetting:null,resultCount:null,resultIndicator:null,
    shopClicks:null,landingPageViews:null,cpmUsd:null,cpcLinkUsd:null,ctrLinkPct:null,ctrAllPct:null,cpcAllUsd:null,
    costPerResultUsd:null,costPerLandingPageViewUsd:null,adsetBudgetLabel:null,adsetBudgetType:null,
    metricUnavailableReasons:{resultCount:"RESULT_MAPPING_UNVERIFIED",shopClicks:"NOT_APPLICABLE",landingPageViews:"ATTRIBUTION_UNVERIFIED"} as MetaApiAdset["metricUnavailableReasons"]};
}
/** Raw nulls stay in the capture; validated predicate or residual evidence derives ad link zeros. */
export function normalizeMetaMcpSnapshot(input: unknown, proofInput?:unknown,catalogInput?:unknown): MetaDaySnapshot {
  let wire:MetaMcpWireSnapshot,evidence:MetaMcpMeasurementEvidence|undefined;
  const derivedIds=new Set<string>(),derivedParentAdsets=new Set<string>();
  if(object(input)&&input.status==="COMPLETE_WIRE_UNVERIFIED_IDENTITY"){
    const selected=selectMetaMcpDay(input),raw=selected.rawWire??selected.wire,targets=selected.wire.levels.ad.filter(r=>r.link_click===null);
    const residual=object(proofInput)&&proofInput.status==="DERIVED_ZERO_RESIDUAL"?validateMetaMcpResidualProof(raw,catalogInput,proofInput):undefined;
    const proof=residual??(targets.length?validateMetaMcpZeroProof(raw,proofInput):undefined);
    for(const row of targets)derivedIds.add(row.id as string);
    for(const row of residual?.derivedParentTargets??[])if(row.level==="adset")derivedParentAdsets.add(row.id);
    if(selected.selection.nullBasicParentProjection&&!residual)fail("RECONCILIATION_FAILED");
    if(!targets.length&&proofInput!==undefined&&!residual?.derivedParentTargets?.length&&!residual?.nullBasicParentProjection)fail("RECONCILIATION_FAILED");
    const semanticQueries=Object.fromEntries(LEVELS.map(l=>{const {client_conversation_id,...q}=raw.queries[l];return[l,q];}));
    const semanticLevels=Object.fromEntries(LEVELS.map(l=>[l,[...raw.levels[l]].sort((a,b)=>(a.id as string).localeCompare(b.id as string))]));
    const captureSemanticFingerprint=hash({accountId:raw.accountId,day:raw.day,levels:semanticLevels,queries:semanticQueries});
    const proofSemanticFingerprint=residual?hash({captureSemanticFingerprint,targetIds:residual.targetIds,parentProof:residual.parentProof,catalogSemanticFingerprint:residual.catalogSemanticFingerprint,premises:residual.premises,method:residual.validationMethod,...(residual.nullBasicParentProjection?{nullBasicParentProjection:residual.nullBasicParentProjection}:{}),...(residual.derivedParentTargets?.length?{derivedParentTargets:residual.derivedParentTargets}:{})}):proof&&"controlId" in proof?hash({captureSemanticFingerprint,targetIds:proof.targetIds,controlId:proof.controlId,rows:[...proof.rows].sort((a,b)=>(a.id as string).localeCompare(b.id as string)),knownTotals:proof.knownTotals,method:"MCP_AD_LINK_CLICK_EQUAL_ZERO_WITH_POSITIVE_CONTROL"}):null;
    evidence={policy:selected.selection.policy,rawStatus:raw.status as "COMPLETE_WIRE_UNVERIFIED_IDENTITY",rawIdentityVerified:false,captureSemanticFingerprint,selectionFingerprint:selected.selection.selectedAdsetFingerprint,
      proofSemanticFingerprint,rawAdsetCount:raw.levels.adset.length,selectedAdsetCount:selected.selectedAdsets.length,excludedAdsetCount:selected.excludedAdsets.length,excludedReason:selected.selection.excludedReason,
      ...(selected.selection.nullBasicParentProjection?{nullBasicParentProjection:selected.selection.nullBasicParentProjection}:{}),linkClickBasis:residual?"DERIVED_ZERO_RESIDUAL":proof?"ZERO_FILTER_VERIFIED":"EXPLICIT_SCALAR",derivedZeroAdCount:targets.length,knownLinkTotal:integer(raw.levels.ad_account[0].link_click),
      ...(residual?{catalogSemanticFingerprint:residual.catalogSemanticFingerprint,countSemantics:residual.premises.countSemantics,snapshotAtomic:false,parentResidualsVerified:true,...(residual.derivedParentTargets?.length?{derivedZeroCampaignCount:residual.derivedParentTargets.filter(row=>row.level==="campaign").length,derivedZeroAdsetCount:derivedParentAdsets.size}:{})}:{})};
    const effective=residual?metaMcpResidualLinkView(raw,catalogInput,residual):{...selected.wire,levels:{...selected.wire.levels,ad:selected.wire.levels.ad.map(r=>r.link_click===null?{...r,link_click:"0"}:r)}};
    const selectedIds=new Set(selected.selectedAdsets.map(row=>row.id));
    wire={...effective,levels:{...effective.levels,adset:effective.levels.adset.filter(row=>selectedIds.has(row.id))}};
  }else{if(proofInput!==undefined)fail("RECONCILIATION_FAILED");wire=validateMetaMcpSnapshot(input);}
  const campaigns=new Map(wire.levels.campaign.map(r=>[r.id,r])),sets=new Map(wire.levels.adset.map(r=>[r.id,r]));
  const parser=new CreativeNameParser(),observed=new Date(wire.observedAtUtc),account=wire.levels.ad_account[0];
  // Check all four independently read totals; only ads/adsets are published as their own levels.
  for (const level of LEVELS) {
    const sum=wire.levels[level].reduce((s,r)=>s.plus(spend(r)),new Prisma.Decimal(0));
    const imps=wire.levels[level].reduce((s,r)=>s+BigInt(integer(r.impressions,true)),0n);
    const links=wire.levels[level].reduce((s,r)=>s+BigInt(integer(r.link_click)),0n);
    const clicks=wire.levels[level].reduce((s,r)=>s+BigInt(integer(r.clicks)),0n);
    if (!sum.eq(spend(account)) || imps!==BigInt(integer(account.impressions,true)) || links!==BigInt(integer(account.link_click))||clicks!==BigInt(integer(account.clicks))) fail("RECONCILIATION_FAILED");
    for(const row of wire.levels[level]){integer(row.reach);fixedDecimal(row.frequency,12,6);}
  }
  for (const adset of wire.levels.adset) {const parent=campaigns.get(adset.campaign_id);if(!parent||parent.name!==adset.campaign_name)fail("RECONCILIATION_FAILED");}
  const ads=wire.levels.ad.map(row=>{
    const adset=sets.get(row.adset_id),campaign=campaigns.get(row.campaign_id);
    if(!adset||!campaign||adset.campaign_id!==row.campaign_id||adset.name!==row.adset_name||campaign.name!==row.campaign_name)fail("RECONCILIATION_FAILED");
    const currentMetadata=metadata(campaign,adset,row,evidence,derivedIds.has(row.id as string));
    const result:MetaApiAd={...common(row),campaignId:row.campaign_id as string,campaignName:row.campaign_name as string,
      adsetId:row.adset_id as string,adsetName:row.adset_name as string,adId:row.id as string,adName:row.name as string,creative:parser.parse(row.name as string),
      sourceRevision:"",currentMetadata,deliveryStatus:currentDeliveryStatus(currentMetadata.ad!),purchaseCount:null,addToCartCount:null,
      videoPlay3sCount:null,videoPlay25Count:null,videoPlay50Count:null,videoPlay75Count:null,videoPlay100Count:null};
    for(const field of ["purchaseCount","addToCartCount","videoPlay3sCount","videoPlay25Count","videoPlay50Count","videoPlay75Count","videoPlay100Count"])result.metricUnavailableReasons[field]="ATTRIBUTION_UNVERIFIED";
    result.sourceRevision=hash({accountId:wire.accountId,day:wire.day,transport:"MCP",protocolVersion:"2025-06-18",row:result});result.metadataObservedAt=observed;return result;
  });
  const adsets=wire.levels.adset.map(row=>{
    const campaign=campaigns.get(row.campaign_id)!;const children=ads.filter(r=>r.adsetId===row.id);
    if(!children.reduce((s,r)=>s.plus(r.spendUsd),new Prisma.Decimal(0)).eq(spend(row)) ||
      children.reduce((s,r)=>s+BigInt(r.impressions),0n)!==BigInt(integer(row.impressions,true)) ||
      children.reduce((s,r)=>s+BigInt(r.inlineLinkClicks),0n)!==BigInt(integer(row.link_click))||children.reduce((s,r)=>s+BigInt(r.clicksAll!),0n)!==BigInt(integer(row.clicks))) fail("RECONCILIATION_FAILED");
    const currentMetadata=metadata(campaign,row,null,evidence,derivedParentAdsets.has(row.id as string));
    const result:MetaApiAdset={...common(row),campaignId:row.campaign_id as string,campaignName:row.campaign_name as string,
      adsetId:row.id as string,adsetName:row.name as string,sourceRevision:"",currentMetadata,deliveryStatus:currentDeliveryStatus(currentMetadata.adset),startDate:null,endStatus:null};
    result.sourceRevision=hash({accountId:wire.accountId,day:wire.day,transport:"MCP",protocolVersion:"2025-06-18",row:result});result.metadataObservedAt=observed;return result;
  });
  for(const campaign of wire.levels.campaign){const children=ads.filter(r=>r.campaignId===campaign.id);
    if(!children.reduce((s,r)=>s.plus(r.spendUsd),new Prisma.Decimal(0)).eq(spend(campaign))||children.reduce((s,r)=>s+BigInt(r.impressions),0n)!==BigInt(integer(campaign.impressions,true))||
      children.reduce((s,r)=>s+BigInt(r.inlineLinkClicks),0n)!==BigInt(integer(campaign.link_click))||children.reduce((s,r)=>s+BigInt(r.clicksAll!),0n)!==BigInt(integer(campaign.clicks)))fail("RECONCILIATION_FAILED");}
  return {ads,adsets,pageCount:wire.pageCount,accountSpendUsd:spend(account),currencyCode:"USD",timeZone:account.timezone_name as string,requestId:null,transport:"MCP",protocolVersion:"2025-06-18",
    settings:{actionReportTime:CONTEXT,attributionWindows:[]}};
}

export class MetaMcpAdsClient extends MetaDayReader {
  readonly transport="MCP" as const;
  private readonly catalog: Json;
  private readonly reporting: unknown;
  constructor(catalog:unknown, reporting:unknown, private readonly reader=new MetaMcpWireReader(fetch,boundedMetaMcpEnvelope)) {
    super();if(!object(catalog)||typeof catalog.client_conversation_id!=="string")fail();
    // Bind immutable public metadata before any request can observe external mutation.
    this.catalog=JSON.parse(JSON.stringify(catalog)) as Json;
    this.reporting=JSON.parse(JSON.stringify(reporting)) as unknown;
    validateMetaMcpCatalog(this.catalog,this.reporting,this.catalog.client_conversation_id as string,"REPORTING_V2");
  }
  async fetchDay(provided:MetaDayReadInput):Promise<MetaDaySnapshot> {
    const input=Object.freeze({...provided});assertMetaOperatingGate("MCP");
    if(input.settings.actionReportTime!==CONTEXT||input.settings.attributionWindows.length!==0||Object.keys(input.settings).some(k=>!["actionReportTime","attributionWindows"].includes(k)))fail("ATTRIBUTION_MISMATCH");
    const wire=await this.reader.fetchDay({accountId:input.accountId,day:input.day,accessToken:input.accessToken,deadlineAt:input.deadlineAt,
      clientConversationId:this.catalog.client_conversation_id as string,catalog:this.catalog,reporting:this.reporting,allowUnverifiedIdentityCapture:true,profile:"REPORTING_V2"});
    try {
    assertMetaOperatingGate("MCP");selectMetaMcpDay(wire);
    const needsProof=metaMcpNeedsLinkProof(wire);
    if(Date.now()>input.deadlineAt)fail("DEADLINE_EXCEEDED");
    const proof=needsProof?createMetaMcpResidualProof(wire,this.catalog):undefined;
    const normalized=normalizeMetaMcpPurchaseSnapshot(wire,{version:1,transport:"META_ADS_MCP",linkProof:proof,purchaseProof:createMetaMcpPurchaseResidualProof(wire,this.catalog)},this.catalog);
    if(Date.now()>input.deadlineAt)fail("DEADLINE_EXCEEDED");assertMetaOperatingGate("MCP");return normalized;
    } catch(error) { markMetaFailureStage(error,"META_NORMALIZE"); throw error; }
  }
}
export type MetaMcpPurchaseProofBundle={version:1;transport:"META_ADS_MCP";linkProof?:unknown;purchaseProof:unknown};
/** Same-capture provider purchases; parent monetary discrepancies are retained, never allocated. */
export function normalizeMetaMcpPurchaseSnapshot(input:unknown,bundle:MetaMcpPurchaseProofBundle,catalog:unknown):MetaDaySnapshot{
 if(!object(bundle)||bundle.version!==1||bundle.transport!=="META_ADS_MCP"||Object.keys(bundle).some(k=>!["version","transport","linkProof","purchaseProof"].includes(k))||!Object.hasOwn(bundle,"purchaseProof"))fail("RECONCILIATION_FAILED");
 const capture=object(input)&&input.status==="COMPLETE_PURCHASE_OBSERVATION_UNVERIFIED"?convertMetaMcpPurchaseObservation(input):input;
 const selection=selectMetaMcpDay(capture),wire=selection.wire;
 if(wire.profile!=="PURCHASE_V1"&&wire.profile!=="REPORTING_V2")fail("RECONCILIATION_FAILED");
 const proof=validateMetaMcpPurchaseResidualProof(capture,catalog,bundle.purchaseProof);
 const normalized=normalizeMetaMcpSnapshot(capture,bundle.linkProof,catalog),derived=new Set(proof.targetIds);
 const derivedParents=proof.derivedParentTargets??[],derivedAdsets=new Set(derivedParents.filter(row=>row.level==="adset").map(row=>row.id));
 const account=wire.levels.ad_account[0],sumValue=(rows:Json[])=>rows.filter(r=>r.omni_purchase_values!==null).reduce((s,r)=>s.plus(metaMcpPurchaseValue(r)),new Prisma.Decimal(0));
 const adValue=sumValue(wire.levels.ad),accountValue=metaMcpPurchaseValue(account);
 // No equality of ad and parent purchase value is asserted. Both exact totals stay visible.
 const evidence:MetaMcpPurchaseMeasurement={countField:"omni_purchase",valueField:"omni_purchase_values",definition:"ATTRIBUTED_OMNI_PURCHASE_EVENTS",reportContext:CONTEXT,snapshotAtomic:false,aliasesCombined:false,derivedZeroAdCount:proof.targetIds.length,...(derivedParents.length?{derivedZeroCampaignCount:derivedParents.filter(row=>row.level==="campaign").length,derivedZeroAdsetCount:derivedAdsets.size}:{}),
  proofSemanticFingerprint:proof.targetIds.length||derivedParents.length?hash({catalogSemanticFingerprint:proof.catalogSemanticFingerprint,parentProof:proof.parentProof,targetIds:proof.targetIds,premises:proof.premises,captureSemanticFingerprint:normalized.ads[0]?.currentMetadata?.sourceContext?.measurementEvidence?.captureSemanticFingerprint,...(derivedParents.length?{derivedParentTargets:derivedParents}:{})}):null,
  catalogSemanticFingerprint:proof.catalogSemanticFingerprint,accountPurchaseCount:Number(integer(account.omni_purchase)),accountPurchaseValueUsd:accountValue.toFixed(4),adPurchaseValueUsd:adValue.toFixed(4),selectedAdsetPurchaseValueUsd:sumValue(selection.selectedAdsets).toFixed(4),parentMinusAdValueUsd:accountValue.minus(adValue).toFixed(4),zeroValuePremise:"EMPTY_PURCHASE_EVENT_SUM",providerScalarZeroObserved:false};
 const attach=(row:MetaApiAd|MetaApiAdset,raw:Json,isAd:boolean)=>{
  const isDerived=isAd?derived.has(raw.id as string):derivedAdsets.has(raw.id as string);
  row.purchaseCount=isDerived?0:Number(integer(raw.omni_purchase));row.purchaseValueUsd=isDerived?"0.0000":metaMcpPurchaseValue(raw).toFixed(4);
  if(raw.omni_purchase===null&&!isDerived)fail("RECONCILIATION_FAILED");
  delete row.metricUnavailableReasons.purchaseCount;
  if(isAd)for(const f of ["videoPlay3sCount","videoPlay25Count","videoPlay50Count","videoPlay75Count","videoPlay100Count"])row.metricUnavailableReasons[f]=wire.profile==="REPORTING_V2"?(f==="videoPlay3sCount"?"UNSUPPORTED_FIELD":"PARTIAL_METRIC"):"NOT_APPLICABLE";
  const ctx=row.currentMetadata?.sourceContext;if(!ctx)fail("RECONCILIATION_FAILED");
  ctx.purchaseMeasurement=evidence;ctx.purchaseCountValueBasis=isDerived?"DERIVED_PURCHASE_ZERO_RESIDUAL":"SOURCE_SCALAR";ctx.purchaseValueBasis=isDerived?"DERIVED_ZERO_EMPTY_PURCHASE_EVENTS":"SOURCE_MONEY";ctx.rawPurchaseNull=isDerived;
  if(wire.profile==="REPORTING_V2") {
    const values: MetaReportingMeasurement["values"] = {};
    for (const field of metaReportingFields(isAd)) {
      const rawValue = raw[META_REPORTING_FIELDS[field]];
      const value = rawValue == null ? null : Number(integer(rawValue));
      values[field] = value;
      (row as unknown as Json)[field] = value;
      if (value === null) row.metricUnavailableReasons[field] = "PARTIAL_METRIC";
      else delete row.metricUnavailableReasons[field];
    }
    ctx.reportingMeasurement = { profile: "REPORTING_V2", rawRowFingerprint: hash(raw), values };
    row.costPerLandingPageViewUsd = row.landingPageViews != null && row.landingPageViews > 0
      ? new Prisma.Decimal(row.spendUsd).div(row.landingPageViews).toFixed(4) : null;
  }
  if(!validCurrentMetadata(row.currentMetadata))fail();
  const {sourceRevision:_revision,metadataObservedAt:_time,...semantic}=row;row.sourceRevision=hash({accountId:wire.accountId,day:wire.day,transport:"MCP",profile:wire.profile,row:semantic});
 };
 normalized.ads.forEach((row,i)=>attach(row,wire.levels.ad[i],true));normalized.adsets.forEach((row,i)=>attach(row,selection.selectedAdsets[i],false));
 return {...normalized,accountPurchaseCount:evidence.accountPurchaseCount,accountPurchaseValueUsd:evidence.accountPurchaseValueUsd,...(selection.selection.nullBasicParentProjection?{nullBasicParentProjection:selection.selection.nullBasicParentProjection}:{})};
}
export function configuredMetaMcpClient(env:NodeJS.ProcessEnv=process.env):MetaMcpAdsClient {
  const read=(path:string|undefined):unknown=>{
    if(!path||!isAbsolute(path))fail();const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>1024*1024)fail();
    return JSON.parse(readFileSync(path,"utf8")) as unknown;
  };
  try { return new MetaMcpAdsClient(read(env.DAILY_SYNC_META_MCP_CATALOG_PATH),read(env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH)); }
  catch { fail(); }
}
