import {Prisma} from "@prisma/client";
import {stableMetadataJson} from "../domain/meta-current-metadata";
import {ProviderFailure} from "./bounded-request";
import {metaMcpFingerprint,selectMetaMcpDay,validateMetaMcpCapture} from "./meta-mcp-capture";
import {MetaMcpWireSnapshot} from "./meta-mcp-wire-reader";
import {createMetaMcpResidualProof,metaMcpResidualLinkView,metaMcpNeedsLinkProof} from "./meta-mcp-residual-proof";
type Json=Record<string,unknown>;
const object=(v:unknown):v is Json=>!!v&&typeof v==="object"&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>stableMetadataJson(a)===stableMetadataJson(b);
const LEVELS=["ad","adset","campaign","ad_account"] as const;
const COUNT="omni_purchase",VALUE="omni_purchase_values";
const COUNT_DEFINITION="The number of purchase events attributed to your ads, based on information received from one or more of your connected Meta Business Tools, or that occur directly on Meta technologies. This doesn't include purchases from messaging ads delivered to and from Europe and Japan.";
function fail():never{throw new ProviderFailure("RECONCILIATION_FAILED",false);}
function integer(v:unknown):bigint{if(typeof v!=="string"||!/^(0|[1-9]\d{0,9})$(?![\s\S])/.test(v)||BigInt(v)>2147483647n)fail();return BigInt(v);}
export function metaMcpPurchaseValue(row:Json):Prisma.Decimal{
 const value=row[VALUE];if(!object(value)||value.unit!=="USD"||typeof value.value!=="string"||!/^(0|[1-9]\d{0,9})(\.\d{1,4})?$(?![\s\S])/.test(value.value))fail();
 return new Prisma.Decimal(value.value);
}
/** Revalidate the new observation without mutating, joining or relabelling older captures. */
export function convertMetaMcpPurchaseObservation(value:unknown):MetaMcpWireSnapshot{
 if(!object(value)||value.status!=="COMPLETE_PURCHASE_OBSERVATION_UNVERIFIED"||value.purchaseAliasesCombined!==false||value.identityVerified!==false||!object(value.levels))fail();
 const levels=value.levels;if(!LEVELS.every(l=>Array.isArray(levels[l])))fail();
 const campaigns=new Set((levels.campaign as Json[]).map(r=>r.id)),sets=new Set((levels.adset as Json[]).map(r=>r.id));
 const missingParentIds={campaign:[...new Set([...(levels.adset as Json[]),...(levels.ad as Json[])].filter(r=>!campaigns.has(r.campaign_id)).map(r=>r.campaign_id as string))].sort(),adset:[...new Set((levels.ad as Json[]).filter(r=>!sets.has(r.adset_id)).map(r=>r.adset_id as string))].sort()};
 const moneyUnits=[...new Set(LEVELS.flatMap(l=>(levels[l] as Json[]).map(r=>object(r.amount_spent)?r.amount_spent.unit:null)))].sort();
 const {purchaseAliasesCombined:_combined,status:_status,...capture}=value;
 return validateMetaMcpCapture({...capture,profile:"PURCHASE_V1",status:"COMPLETE_WIRE_UNVERIFIED_IDENTITY",missingParentIds,moneyUnits});
}
export const META_MCP_PURCHASE_PREMISES=Object.freeze({countSemantics:"NONNEGATIVE_ADDITIVE_ATTRIBUTED_PURCHASE_EVENTS",valueSemantics:"EMPTY_PURCHASE_EVENT_SUM",sameCanonicalPairAndQuery:true,snapshotAtomic:false,providerScalarZeroObserved:false,aliasEquivalenceVerified:false} as const);
export type MetaMcpPurchaseProof={version:1;status:"DERIVED_PURCHASE_ZERO_RESIDUAL";rawCaptureFingerprint:string;catalogSemanticFingerprint:string;accountId:string;day:string;targetIds:string[];parentProof:Json[];premises:typeof META_MCP_PURCHASE_PREMISES;rawNullsPreserved:true;providerRequests:0;observedAtUtc:string;proofFingerprint:string;derivedParentTargets?:MetaMcpDerivedParentTarget[];nullBasicParentProjection?:ReturnType<typeof selectMetaMcpDay>["selection"]["nullBasicParentProjection"]};
function catalogFingerprint(catalog:unknown,clientId:string){
 if(!object(catalog)||catalog.version!==1||catalog.client_conversation_id!==clientId||catalog.server!=="https://mcp.facebook.com/ads"||catalog.tool!=="ads_get_field_context"||!Array.isArray(catalog.fields))fail();
 const definitions=[];
 for(const [name,type,description]of [[COUNT,"INTEGER",COUNT_DEFINITION],[VALUE,"CURRENCY","The total value of purchases."]]){
  const fields=catalog.fields.filter(f=>object(f)&&f.name===name);if(fields.length!==1)fail();const f=fields[0];
  if(!object(f)||f.type!==type||f.is_metric!==true||f.description!==description||!Array.isArray(f.levels)||!same([...f.levels].sort(),[...LEVELS].sort()))fail();
  definitions.push({name,type,description,is_metric:true,levels:[...LEVELS].sort()});
 }return metaMcpFingerprint(definitions);
}
export type MetaMcpDerivedParentTarget={level:"campaign"|"adset";id:string;rawCount:null;rawValue:null;basis:"DERIVED_PURCHASE_ZERO_RESIDUAL"};
/** A complete nonnegative hierarchy permits only zero residuals, never allocation. */
function deriveParentZeros(wire:MetaMcpWireSnapshot,selected:ReturnType<typeof selectMetaMcpDay>){
 const targets:MetaMcpDerivedParentTarget[]=[];
 if(![...wire.levels.campaign,...selected.selectedAdsets].some(row=>row[COUNT]===null))return {wire,selected,targets};
 const account=wire.levels.ad_account[0];integer(account[COUNT]);metaMcpPurchaseValue(account);
 const total=(rows:Json[],field:string)=>rows.reduce((sum,row)=>sum+(row[field]===null?0n:integer(row[field])),0n);
 const spend=(row:Json)=>{if(!object(row.amount_spent)||row.amount_spent.unit!=="USD"||typeof row.amount_spent.value!=="string")fail();return new Prisma.Decimal(row.amount_spent.value);};
 const infer=(parent:Json,children:Json[],level:"campaign"|"adset")=>{
  if(total(children,COUNT)!==integer(parent[COUNT])||!children.reduce((sum,row)=>sum.plus(spend(row)),new Prisma.Decimal(0)).eq(spend(parent))||["impressions","clicks","link_click"].some(field=>total(children,field)!==integer(parent[field])))fail();
  return children.map(row=>{if(row[COUNT]!==null)return row;if(row[VALUE]!==null)fail();targets.push({level,id:row.id as string,rawCount:null,rawValue:null,basis:"DERIVED_PURCHASE_ZERO_RESIDUAL"});return {...row,[COUNT]:"0",[VALUE]:{value:"0.0000",unit:"USD"}};});
 };
 const campaigns=infer(account,wire.levels.campaign,"campaign");
 const adsets=campaigns.flatMap(parent=>infer(parent,selected.selectedAdsets.filter(row=>row.campaign_id===parent.id),"adset"));
 const replacements=new Map(adsets.map(row=>[row.id,row]));
 const effective={...wire,levels:{...wire.levels,campaign:campaigns,adset:wire.levels.adset.map(row=>replacements.get(row.id)??row)}};
 for(const target of targets)if(LEVELS.filter(level=>level!==target.level).some(level=>wire.levels[level].some(row=>row.id===target.id)))fail();
 targets.sort((a,b)=>a.level.localeCompare(b.level)||a.id.localeCompare(b.id));
 return {wire:effective,selected:{...selected,wire:effective,selectedAdsets:adsets},targets};
}
function derive(capture:unknown,catalog:unknown){
 let selected=selectMetaMcpDay(capture),wire=selected.wire;if(wire.profile!=="PURCHASE_V1")fail();
 const catalogSemanticFingerprint=catalogFingerprint(catalog,wire.clientConversationId),targets=wire.levels.ad.filter(r=>r[COUNT]===null);
 for(const rows of Object.values(wire.levels))for(const row of rows)for(const[count,value]of [[COUNT,VALUE],["offsite_conversion_fb_pixel_purchase","offsite_conversion_fb_pixel_purchase_values"]]){
  if((row[count]===null)!==(row[value]===null))fail();
  if(row[count]!==null&&integer(row[count])===0n&&object(row[value])&&!new Prisma.Decimal(row[value].value as string).isZero())fail();
 }
 if(targets.some(r=>r[VALUE]!==null))fail();
 if(metaMcpNeedsLinkProof(wire)){
  const linkProof=createMetaMcpResidualProof(wire,catalog);
  if(linkProof.derivedParentTargets?.length){const effective=metaMcpResidualLinkView(wire,catalog,linkProof),selectedIds=new Set(selected.selectedAdsets.map(row=>row.id));wire=effective;selected={...selected,wire:effective,selectedAdsets:effective.levels.adset.filter(row=>selectedIds.has(row.id))};}
 }
 const parents=deriveParentZeros(wire,selected);wire=parents.wire;selected=parents.selected;
 for(const row of [...wire.levels.ad,...selected.selectedAdsets,...wire.levels.campaign,...wire.levels.ad_account]){
  if(row[COUNT]===null){if(row[VALUE]!==null)fail();}else{const n=integer(row[COUNT]),v=metaMcpPurchaseValue(row);if(n===0n&&!v.isZero())fail();}
 }
 const parentProof:Json[]=[];
 const total=(rows:Json[])=>rows.reduce((s,r)=>s+(r[COUNT]===null?0n:integer(r[COUNT])),0n);
 const check=(parent:Json,children:Json[],descendants:Json[],level:string)=>{
  const parentCount=integer(parent[COUNT]),known=total(descendants);if(total(children)!==parentCount||known!==parentCount)fail();
  const coreCount=(rows:Json[],field:string)=>rows.reduce((n,r)=>n+(r[field]===null?0n:integer(r[field])),0n);
  const coreSpend=(r:Json)=>{if(!object(r.amount_spent)||r.amount_spent.unit!=="USD"||typeof r.amount_spent.value!=="string")fail();return new Prisma.Decimal(r.amount_spent.value);};
  if(!children.reduce((n,r)=>n.plus(coreSpend(r)),new Prisma.Decimal(0)).eq(coreSpend(parent))||["impressions","clicks","link_click"].some(f=>coreCount(children,f)!==integer(parent[f])||coreCount(descendants,f)!==integer(parent[f])))fail();
  const knownValue=descendants.filter(r=>r[VALUE]!==null).reduce((s,r)=>s.plus(metaMcpPurchaseValue(r)),new Prisma.Decimal(0)),parentValue=metaMcpPurchaseValue(parent);
  parentProof.push({level,id:parent.id,childIdsFingerprint:metaMcpFingerprint(children.map(r=>r.id).sort()),parentCount:parentCount.toString(),knownCount:known.toString(),residualCount:"0",nullPurchaseAdCount:descendants.filter(r=>r[COUNT]===null).length,parentValueUsd:parentValue.toFixed(4),knownAdValueUsd:knownValue.toFixed(4),valueDifferenceUsd:parentValue.minus(knownValue).toFixed(4)});
 };
 for(const p of selected.selectedAdsets){const ads=wire.levels.ad.filter(r=>r.adset_id===p.id);check(p,ads,ads,"adset");}
 for(const p of wire.levels.campaign)check(p,selected.selectedAdsets.filter(r=>r.campaign_id===p.id),wire.levels.ad.filter(r=>r.campaign_id===p.id),"campaign");
 check(wire.levels.ad_account[0],wire.levels.campaign,wire.levels.ad,"ad_account");
 if(total(wire.levels.ad)!==integer(wire.levels.ad_account[0][COUNT])||total(selected.selectedAdsets)!==integer(wire.levels.ad_account[0][COUNT]))fail();
 parentProof.sort((a,b)=>String(a.level).localeCompare(String(b.level))||String(a.id).localeCompare(String(b.id)));
 return {version:1 as const,status:"DERIVED_PURCHASE_ZERO_RESIDUAL" as const,rawCaptureFingerprint:selected.selection.rawCaptureFingerprint,catalogSemanticFingerprint,accountId:wire.accountId,day:wire.day,targetIds:targets.map(r=>r.id as string).sort(),parentProof,premises:META_MCP_PURCHASE_PREMISES,rawNullsPreserved:true as const,providerRequests:0 as const,...(selected.selection.nullBasicParentProjection?{nullBasicParentProjection:selected.selection.nullBasicParentProjection}:{}),...(parents.targets.length?{derivedParentTargets:parents.targets}:{})};
}
export function createMetaMcpPurchaseResidualProof(capture:unknown,catalog:unknown):MetaMcpPurchaseProof{
 const body={...derive(capture,catalog),observedAtUtc:new Date().toISOString()};return{...body,proofFingerprint:metaMcpFingerprint(body)};
}
export function validateMetaMcpPurchaseResidualProof(capture:unknown,catalog:unknown,value:unknown):MetaMcpPurchaseProof{
 const expected=derive(capture,catalog);if(!object(value)||typeof value.observedAtUtc!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(value.observedAtUtc)||!Number.isFinite(Date.parse(value.observedAtUtc))||new Date(value.observedAtUtc).toISOString()!==value.observedAtUtc||Date.parse(value.observedAtUtc)>Date.now()+300000||!object(capture)||Date.parse(value.observedAtUtc)<Date.parse(capture.observedAtUtc as string))fail();
 const{proofFingerprint,observedAtUtc,...body}=value;if(!same(body,expected)||proofFingerprint!==metaMcpFingerprint({...body,observedAtUtc}))fail();return value as MetaMcpPurchaseProof;
}
