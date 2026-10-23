import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { stableMetadataJson, MetaMcpNullBasicProjection } from "../domain/meta-current-metadata";
import { ProviderFailure } from "./bounded-request";
import { parseIsoDate } from "./sync-contract";
import { META_MCP_DAY_FIELDS, META_MCP_PURCHASE_FIELDS, META_MCP_PURCHASE_NAMES, MetaMcpLevel, MetaMcpWireSnapshot, validateMetaMcpWireRow } from "./meta-mcp-wire-reader";
type Json=Record<string,unknown>;
const LEVELS:MetaMcpLevel[]=["ad","adset","campaign","ad_account"];
function reject():never{throw new ProviderFailure("RECONCILIATION_FAILED",false);}
const object=(v:unknown):v is Json=>!!v&&typeof v==="object"&&!Array.isArray(v);
export const metaMcpFingerprint=(v:unknown)=>createHash("sha256").update(stableMetadataJson(v)).digest("hex");
export type MetaMcpSelection={policy:"REFERENCED_ADSETS_FROM_COMPLETE_WIRE";rawCaptureFingerprint:string;rawStatus:"COMPLETE_WIRE_UNVERIFIED_IDENTITY";rawIdentityVerified:false;
 rawAdsetCount:number;selectedAdsetCount:number;excludedAdsetCount:number;selectedAdsetFingerprint:string;excludedReason:"CURRENT_METADATA_ONLY_UNREFERENCED";nullBasicParentProjection?:MetaMcpNullBasicProjection};
/** Preserves the raw capture's false identity attestation while rechecking its complete wire scope. */
export function validateMetaMcpCapture(value:unknown):MetaMcpWireSnapshot{
 if(!object(value)||value.version!==1||value.transport!=="META_ADS_MCP"||value.status!=="COMPLETE_WIRE_UNVERIFIED_IDENTITY"||value.identityVerified!==false||
  typeof value.accountId!=="string"||!/^\d{1,30}$(?![\s\S])/.test(value.accountId)||typeof value.day!=="string"||
  typeof value.clientConversationId!=="string"||!/^[A-Za-z0-9]{20}$(?![\s\S])/.test(value.clientConversationId)||!/[a-z]/.test(value.clientConversationId)||!/[A-Z]/.test(value.clientConversationId)||!/[0-9]/.test(value.clientConversationId)||
  typeof value.observedAtUtc!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(value.observedAtUtc)||!Number.isFinite(Date.parse(value.observedAtUtc))||new Date(value.observedAtUtc).toISOString()!==value.observedAtUtc||Date.parse(value.observedAtUtc)>Date.now()+300000||
  !Number.isInteger(value.pageCount)||(value.pageCount as number)<4||(value.pageCount as number)>100||!Number.isInteger(value.byteCount)||(value.byteCount as number)<1||(value.byteCount as number)>16*1024*1024||
  !object(value.levels)||!object(value.queries)||!object(value.missingParentIds)||!Array.isArray(value.moneyUnits)||
  ["paginationComplete","datesVerified"].some(k=>value[k]!==true)||["currencyVerified","attributionVerified","metricsNormalized","productionReady"].some(k=>value[k]!==false))reject();
 parseIsoDate(value.day);
 if(value.profile!==undefined&&value.profile!=="PURCHASE_V1")reject();
 const fields=value.profile?META_MCP_PURCHASE_FIELDS:META_MCP_DAY_FIELDS;
 if(Object.keys(value.levels).sort().join()!==[...LEVELS].sort().join()||Object.keys(value.queries).sort().join()!==[...LEVELS].sort().join())reject();
 const levels={} as Record<MetaMcpLevel,Json[]>;let count=0;
 for(const level of LEVELS){const rows=value.levels[level];
  const query={ad_account_id:value.accountId,fields:[...fields[level]],level,time_range:JSON.stringify({since:value.day,until:value.day}),time_increment:"1",object_state:"live",include_additional_context:false,client_conversation_id:value.clientConversationId,limit:1000};
  if(stableMetadataJson(value.queries[level])!==stableMetadataJson(query)||!Array.isArray(rows)||rows.length>50000-count)reject();
  const seen=new Set<string>();levels[level]=rows.map((raw,index)=>{
   if(!object(raw)||Object.keys(raw).some(k=>![...fields[level],"date_start","date_stop"].includes(k)))reject();
   const checked=validateMetaMcpWireRow(raw,level,value.accountId as string,value.day as string,index,value.profile as "PURCHASE_V1"|undefined);
   if(stableMetadataJson(checked)!==stableMetadataJson(raw)||seen.has(checked.id as string))reject();seen.add(checked.id as string);return checked;
  });count+=rows.length;
 }
 if(levels.ad_account.length!==1)reject();
 const campaigns=new Set(levels.campaign.map(r=>r.id)),sets=new Set(levels.adset.map(r=>r.id));
 const missing={campaign:[...new Set([...levels.adset,...levels.ad].filter(r=>!campaigns.has(r.campaign_id)).map(r=>r.campaign_id as string))].sort(),adset:[...new Set(levels.ad.filter(r=>!sets.has(r.adset_id)).map(r=>r.adset_id as string))].sort()};
 if(stableMetadataJson(missing)!==stableMetadataJson(value.missingParentIds))reject();
 const units=[...new Set(LEVELS.flatMap(l=>levels[l].map(r=>(r.amount_spent as Json).unit)))].sort();if(stableMetadataJson(units)!==stableMetadataJson(value.moneyUnits))reject();
 return {...value,levels} as MetaMcpWireSnapshot;
}
/** Narrow membership proof only. No raw metric is filled or changed. */
function nullBasicParentProjection(wire:MetaMcpWireSnapshot){
 const money=(r:Json,field="amount_spent")=>{const v=r[field];if(!object(v)||v.unit!=="USD"||typeof v.value!=="string"||!/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(v.value))reject();return new Prisma.Decimal(v.value);};
 const count=(v:unknown)=>{if(typeof v!=="string"||!/^(0|[1-9]\d{0,18})$/.test(v)||BigInt(v)>9223372036854775807n)reject();return BigInt(v);};
 const pairs=[["omni_purchase","omni_purchase_values"],["offsite_conversion_fb_pixel_purchase","offsite_conversion_fb_pixel_purchase_values"]];
 const nullFields=["impressions","clicks","reach","frequency","link_click",...pairs.flat()];
 const parents=wire.levels.adset.filter(r=>money(r).isZero()&&nullFields.every(k=>r[k]===null)&&wire.levels.ad.some(a=>a.adset_id===r.id));
 if(!parents.length)return undefined;
 if(wire.profile!=="PURCHASE_V1")reject();
 const parentIds=new Set(parents.map(r=>r.id)),removed=wire.levels.ad.filter(r=>parentIds.has(r.adset_id));
 const metrics=["impressions","clicks","link_click",...pairs.map(p=>p[0])];
 const total=(rows:Json[],f:string)=>rows.reduce((n,r)=>n+(r[f]===null?0n:count(r[f])),0n);
 const sumMoney=(rows:Json[])=>rows.reduce((n,r)=>n.plus(money(r)),new Prisma.Decimal(0));
 for(const rows of Object.values(wire.levels))for(const r of rows){money(r);for(const f of metrics)if(r[f]!==null)count(r[f]);for(const [c,v]of pairs){if((r[c]===null)!==(r[v]===null))reject();if(r[c]!==null&&count(r[c])===0n&&!money(r,v).isZero())reject();if(r[v]!==null)money(r,v);}}
 for(const r of removed){if(!money(r).isZero()||["impressions","clicks","reach","frequency"].some(f=>typeof r[f]!=="string"||!/^0(?:\.0+)?$/.test(r[f] as string))||metrics.some(f=>r[f]!==null&&count(r[f])!==0n)||pairs.some(([c,v])=>r[c]!==null&&(count(r[c])!==0n||!money(r,v).isZero())))reject();}
 const account=wire.levels.ad_account[0];for(const f of metrics)count(account[f]);
 const check=(p:Json,children:Json[],descendants:Json[])=>{if(!sumMoney(children).eq(money(p))||!sumMoney(descendants).eq(money(p)))reject();for(const f of metrics){const expected=p[f]===null?0n:count(p[f]);if(total(children,f)!==expected||total(descendants,f)!==expected)reject();}};
 for(const p of wire.levels.adset){const children=wire.levels.ad.filter(a=>a.adset_id===p.id);check(p,children,children);}
 for(const p of wire.levels.campaign)check(p,wire.levels.adset.filter(r=>r.campaign_id===p.id),wire.levels.ad.filter(r=>r.campaign_id===p.id));
 check(account,wire.levels.campaign,wire.levels.ad);for(const rows of [wire.levels.ad,wire.levels.adset]){if(!sumMoney(rows).eq(money(account))||metrics.some(f=>total(rows,f)!==count(account[f])))reject();}
 const ids=new Set(removed.map(r=>r.id)),ads=wire.levels.ad.filter(r=>!ids.has(r.id)),references=new Set(ads.map(r=>r.adset_id));
 if(parents.some(p=>references.has(p.id)))reject();
 const sets=wire.levels.adset.filter(r=>references.has(r.id));
 for(const r of sets){if(["impressions","clicks","reach","frequency"].some(f=>r[f]===null))reject();}
 for(const rows of [ads,sets]){if(!sumMoney(rows).eq(money(account))||metrics.some(f=>total(rows,f)!==count(account[f])))reject();}
 for(const p of sets){const children=ads.filter(r=>r.adset_id===p.id);check(p,children,children);}for(const p of wire.levels.campaign)check(p,sets.filter(r=>r.campaign_id===p.id),ads.filter(r=>r.campaign_id===p.id));
 const excludedAds=removed.map(r=>r.id as string).sort(),excludedSets=parents.map(r=>r.id as string).sort(),rawCaptureFingerprint=metaMcpFingerprint(wire),rule="EXPLICIT_ZERO_CHILDREN_OF_NULL_BASIC_ADSETS" as const;
 const projection:MetaMcpNullBasicProjection={version:1,rule,rawAdCount:wire.levels.ad.length,selectedAdCount:ads.length,excludedAdCount:removed.length,excludedAdsetCount:parents.length,excludedAdIdsFingerprint:metaMcpFingerprint(excludedAds),excludedAdsetIdsFingerprint:metaMcpFingerprint(excludedSets),proofFingerprint:metaMcpFingerprint({version:1,rule,rawCaptureFingerprint,excludedAds,excludedSets,accountObserved:true,allHierarchyCountsAndSpendPreserved:true,nullMetricsFilled:false,monetaryDifferencesAllocated:false})};
 return {wire:{...wire,levels:{...wire.levels,ad:ads}},projection};
}
export function selectMetaMcpDay(capture:unknown){
 const original=validateMetaMcpCapture(capture);
 const campaignMap=new Map(original.levels.campaign.map(r=>[r.id,r])),setMap=new Map(original.levels.adset.map(r=>[r.id,r]));
 for(const row of original.levels.adset){const parent=campaignMap.get(row.campaign_id);if(!parent||parent.name!==row.campaign_name)reject();}
 for(const row of original.levels.ad){const parent=setMap.get(row.adset_id),campaign=campaignMap.get(row.campaign_id);if(!parent||!campaign||parent.campaign_id!==row.campaign_id||parent.name!==row.adset_name||campaign.name!==row.campaign_name)reject();}
 const projected=nullBasicParentProjection(original),wire=projected?.wire??original,references=new Set(wire.levels.ad.map(r=>r.adset_id as string));
 const selected=wire.levels.adset.filter(r=>references.has(r.id as string)),excluded=wire.levels.adset.filter(r=>!references.has(r.id as string));if(selected.length!==references.size)reject();
 for(const row of excluded){if(!new Prisma.Decimal((row.amount_spent as Json).value as string).isZero()||["impressions","link_click","clicks","reach","frequency"].some(f=>row[f]!==null&&(typeof row[f]!=="string"||!new Prisma.Decimal(row[f] as string).isZero())))reject();if(wire.profile&&META_MCP_PURCHASE_NAMES.some(f=>row[f]!==null&&!new Prisma.Decimal(f.endsWith("_values")?(row[f] as Json).value as string:row[f] as string).isZero()))reject();}
 const selection:MetaMcpSelection={policy:"REFERENCED_ADSETS_FROM_COMPLETE_WIRE",rawCaptureFingerprint:metaMcpFingerprint(original),rawStatus:"COMPLETE_WIRE_UNVERIFIED_IDENTITY",rawIdentityVerified:false,rawAdsetCount:wire.levels.adset.length,selectedAdsetCount:selected.length,excludedAdsetCount:excluded.length,selectedAdsetFingerprint:metaMcpFingerprint([...references].sort()),excludedReason:"CURRENT_METADATA_ONLY_UNREFERENCED",...(projected?{nullBasicParentProjection:projected.projection}:{})};
 return {wire,...(projected?{rawWire:original}:{}),selectedAdsets:selected,excludedAdsets:excluded,selection};
}
