import {Prisma} from "@prisma/client";
import {stableMetadataJson} from "../domain/meta-current-metadata";
import {ProviderFailure} from "./bounded-request";
import {metaMcpFingerprint,selectMetaMcpDay} from "./meta-mcp-capture";
import {MetaMcpWireSnapshot} from "./meta-mcp-wire-reader";
type Json=Record<string,unknown>;
const object=(v:unknown):v is Json=>!!v&&typeof v==="object"&&!Array.isArray(v);
const DEFINITION="The number of clicks on links within the ad that led to advertiser-specified destinations, on or off Meta technologies.";
const LEVELS=["ad","adset","campaign","ad_account"] as const;
const same=(a:unknown,b:unknown)=>stableMetadataJson(a)===stableMetadataJson(b);
function fail():never{throw new ProviderFailure("RECONCILIATION_FAILED",false);}
function integer(v:unknown):bigint{if(typeof v!=="string"||!/^(0|[1-9]\d{0,18})$(?![\s\S])/.test(v)||BigInt(v)>9223372036854775807n)fail();return BigInt(v);}
function spend(r:Json){if(!object(r.amount_spent)||r.amount_spent.unit!=="USD"||typeof r.amount_spent.value!=="string")fail();const n=new Prisma.Decimal(r.amount_spent.value);if(n.isNegative()||n.decimalPlaces()>4||n.gte("10000000000"))fail();return n;}
export const META_MCP_RESIDUAL_PREMISES=Object.freeze({countSemantics:"NONNEGATIVE_ADDITIVE_LINK_EVENTS",sameDayScope:true,parentConservation:"SPEND_IMPRESSIONS_CLICKS_LINK_RESIDUAL",snapshotAtomic:false,providerScalarZeroObserved:false,aliasEquivalenceVerified:false} as const);
export type MetaMcpParentResidual={level:"adset"|"campaign"|"ad_account";id:string;childIdsFingerprint:string;spendUsd:string;impressions:string;clicks:string;knownLinkClicks:string;parentLinkClicks:string;residualLinkClicks:"0";nullAdLinkCount:number};
export type MetaMcpResidualProof={version:1;status:"DERIVED_ZERO_RESIDUAL";validationMethod:"ZERO_RESIDUAL_VERIFIED";rawCaptureFingerprint:string;catalogSemanticFingerprint:string;
 accountId:string;day:string;targetIds:string[];parentProof:MetaMcpParentResidual[];knownLinkTotal:string;premises:typeof META_MCP_RESIDUAL_PREMISES;
 rawNullsPreserved:true;providerRequests:0;observedAtUtc:string;proofFingerprint:string;derivedParentTargets?:MetaMcpLinkParentTarget[];nullBasicParentProjection?:ReturnType<typeof selectMetaMcpDay>["selection"]["nullBasicParentProjection"]};
export type MetaMcpLinkParentTarget={level:"campaign"|"adset";id:string;rawLinkClick:null;basis:"DERIVED_ZERO_RESIDUAL"};
function catalogFingerprint(catalog:unknown,clientId:string){
 if(!object(catalog)||catalog.version!==1||catalog.server!=="https://mcp.facebook.com/ads"||catalog.tool!=="ads_get_field_context"||catalog.client_conversation_id!==clientId||!Array.isArray(catalog.fields))fail();
 const fields=catalog.fields.filter(f=>object(f)&&f.name==="link_click");if(fields.length!==1)fail();const f=fields[0];
 if(!object(f)||f.type!=="INTEGER"||f.is_metric!==true||f.description!==DEFINITION||!Array.isArray(f.levels)||!same([...f.levels].sort(),[...LEVELS].sort()))fail();
 return metaMcpFingerprint({name:"link_click",type:"INTEGER",is_metric:true,description:DEFINITION,levels:[...LEVELS].sort()});
}
function deriveLinkParentZeros(selected:ReturnType<typeof selectMetaMcpDay>){
 const wire=selected.wire,targets:MetaMcpLinkParentTarget[]=[];
 if(![...wire.levels.campaign,...selected.selectedAdsets].some(row=>row.link_click===null))return {selected,wire,targets};
 integer(wire.levels.ad_account[0].link_click);
 const total=(rows:Json[],field:string)=>rows.reduce((n,row)=>n+(row[field]===null?0n:integer(row[field])),0n);
 const infer=(parent:Json,children:Json[],level:"campaign"|"adset")=>{
  if(total(children,"link_click")!==integer(parent.link_click)||!children.reduce((sum,row)=>sum.plus(spend(row)),new Prisma.Decimal(0)).eq(spend(parent))||["impressions","clicks"].some(field=>total(children,field)!==integer(parent[field])))fail();
  return children.map(row=>{if(row.link_click!==null)return row;targets.push({level,id:row.id as string,rawLinkClick:null,basis:"DERIVED_ZERO_RESIDUAL"});return {...row,link_click:"0"};});
 };
 const campaigns=infer(wire.levels.ad_account[0],wire.levels.campaign,"campaign");
 const adsets=campaigns.flatMap(parent=>infer(parent,selected.selectedAdsets.filter(row=>row.campaign_id===parent.id),"adset"));
 for(const target of targets)if(LEVELS.filter(level=>level!==target.level).some(level=>wire.levels[level].some(row=>row.id===target.id)))fail();
 targets.sort((a,b)=>a.level.localeCompare(b.level)||a.id.localeCompare(b.id));
 const replacements=new Map(adsets.map(row=>[row.id,row]));
 const effective={...wire,levels:{...wire.levels,campaign:campaigns,adset:wire.levels.adset.map(row=>replacements.get(row.id)??row)}};
 return {wire:effective,selected:{...selected,wire:effective,selectedAdsets:adsets},targets};
}
function derive(capture:unknown,catalog:unknown){
 let selected=selectMetaMcpDay(capture),wire=selected.wire;
 const catalogSemanticFingerprint=catalogFingerprint(catalog,wire.clientConversationId),targetIds=wire.levels.ad.filter(r=>r.link_click===null).map(r=>r.id as string).sort();
 if(!selected.selection.nullBasicParentProjection&&!targetIds.length&&![...selected.selectedAdsets,...wire.levels.campaign,...wire.levels.ad_account].some(row=>row.link_click===null))fail();
 const scoped=[...wire.levels.ad,...selected.selectedAdsets,...wire.levels.campaign,...wire.levels.ad_account];
 for(const r of scoped){spend(r);for(const f of ["impressions","clicks","reach"])integer(r[f]);
  if(typeof r.frequency!=="string"||!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$(?![\s\S])/.test(r.frequency))fail();
  if(r.link_click!==null)integer(r.link_click);
 }
 const derivedParents=deriveLinkParentZeros(selected);selected=derivedParents.selected;wire=derivedParents.wire;
 if([...selected.selectedAdsets,...wire.levels.campaign,...wire.levels.ad_account].some(r=>r.link_click===null))fail();
 const parents:MetaMcpParentResidual[]=[];
 const check=(parent:Json,children:Json[],descendantAds:Json[],level:MetaMcpParentResidual["level"])=>{
  const totalSpend=children.reduce((n,r)=>n.plus(spend(r)),new Prisma.Decimal(0));
  const total=(rows:Json[],field:string)=>rows.reduce((n,r)=>n+(r[field]===null?0n:integer(r[field])),0n);
  const known=total(descendantAds,"link_click"),parentLinks=integer(parent.link_click);
  if(!totalSpend.eq(spend(parent))||total(children,"impressions")!==integer(parent.impressions)||total(children,"clicks")!==integer(parent.clicks)||
   total(children,"link_click")!==parentLinks||known!==parentLinks)fail();
  parents.push({level,id:parent.id as string,childIdsFingerprint:metaMcpFingerprint(children.map(r=>r.id as string).sort()),spendUsd:totalSpend.toFixed(4),impressions:integer(parent.impressions).toString(),clicks:integer(parent.clicks).toString(),knownLinkClicks:known.toString(),parentLinkClicks:parentLinks.toString(),residualLinkClicks:"0",nullAdLinkCount:descendantAds.filter(r=>r.link_click===null).length});
 };
 for(const parent of selected.selectedAdsets){const children=wire.levels.ad.filter(r=>r.adset_id===parent.id);check(parent,children,children,"adset");}
 for(const parent of wire.levels.campaign){const children=selected.selectedAdsets.filter(r=>r.campaign_id===parent.id),ads=wire.levels.ad.filter(r=>r.campaign_id===parent.id);check(parent,children,ads,"campaign");}
 check(wire.levels.ad_account[0],wire.levels.campaign,wire.levels.ad,"ad_account");
 // Independently conserve the account across ads and selected adsets as well.
 const account=wire.levels.ad_account[0];for(const rows of [wire.levels.ad,selected.selectedAdsets]){
  if(!rows.reduce((n,r)=>n.plus(spend(r)),new Prisma.Decimal(0)).eq(spend(account))||
   ["impressions","clicks","link_click"].some(f=>rows.reduce((n,r)=>n+(r[f]===null?0n:integer(r[f])),0n)!==integer(account[f])))fail();
 }
 parents.sort((a,b)=>a.level.localeCompare(b.level)||a.id.localeCompare(b.id));
 return{version:1 as const,status:"DERIVED_ZERO_RESIDUAL" as const,validationMethod:"ZERO_RESIDUAL_VERIFIED" as const,rawCaptureFingerprint:selected.selection.rawCaptureFingerprint,catalogSemanticFingerprint,
 accountId:wire.accountId,day:wire.day,targetIds,parentProof:parents,knownLinkTotal:integer(account.link_click).toString(),premises:META_MCP_RESIDUAL_PREMISES,rawNullsPreserved:true as const,providerRequests:0 as const,...(selected.selection.nullBasicParentProjection?{nullBasicParentProjection:selected.selection.nullBasicParentProjection}:{}),...(derivedParents.targets.length?{derivedParentTargets:derivedParents.targets}:{})};
}
/** Offline mathematical derivation; this never requests or claims a provider scalar zero. */
export function createMetaMcpResidualProof(capture:unknown,catalog:unknown):MetaMcpResidualProof{
 const body={...derive(capture,catalog),observedAtUtc:new Date().toISOString()};return{...body,proofFingerprint:metaMcpFingerprint(body)};
}
export function validateMetaMcpResidualProof(capture:unknown,catalog:unknown,value:unknown):MetaMcpResidualProof{
 const expected=derive(capture,catalog);if(!object(value)||typeof value.observedAtUtc!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(value.observedAtUtc)||!Number.isFinite(Date.parse(value.observedAtUtc))||new Date(value.observedAtUtc).toISOString()!==value.observedAtUtc||Date.parse(value.observedAtUtc)>Date.now()+300000||!object(capture)||typeof capture.observedAtUtc!=="string"||Date.parse(value.observedAtUtc)<Date.parse(capture.observedAtUtc))fail();
 const {proofFingerprint,observedAtUtc,...semantic}=value;if(!same(semantic,expected)||proofFingerprint!==metaMcpFingerprint({...semantic,observedAtUtc}))fail();return value as MetaMcpResidualProof;
}
/** Effective links for this validated proof only; the immutable capture stays raw. */
export function metaMcpResidualLinkView(capture:unknown,catalog:unknown,value:unknown):MetaMcpWireSnapshot{
 const proof=validateMetaMcpResidualProof(capture,catalog,value),wire=selectMetaMcpDay(capture).wire;
 const targets=proof.derivedParentTargets??[],ads=new Set(proof.targetIds),campaigns=new Set(targets.filter(row=>row.level==="campaign").map(row=>row.id)),adsets=new Set(targets.filter(row=>row.level==="adset").map(row=>row.id));
 return {...wire,levels:{...wire.levels,ad:wire.levels.ad.map(row=>ads.has(row.id as string)?{...row,link_click:"0"}:row),campaign:wire.levels.campaign.map(row=>campaigns.has(row.id as string)?{...row,link_click:"0"}:row),adset:wire.levels.adset.map(row=>adsets.has(row.id as string)?{...row,link_click:"0"}:row)}};
}
export function metaMcpNeedsLinkProof(capture:unknown){
 const selected=selectMetaMcpDay(capture),wire=selected.wire;
 return !!selected.selection.nullBasicParentProjection||[...wire.levels.ad,...selected.selectedAdsets,...wire.levels.campaign,...wire.levels.ad_account].some(row=>row.link_click===null);
}
