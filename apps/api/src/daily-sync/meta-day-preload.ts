/** One bounded, parameterized read for the exact original Meta day-batch scopes. */
import {Prisma} from '@prisma/client';
import {createHash} from 'node:crypto';
import type {MetaApiAd,MetaApiAdset} from './canonical-api-writer.service';
import {syncError} from './sync-contract';
export const META_PRELOAD_MODELS=['metaAdDailyMetric','metaAdsetDailyMetric','metaAdset','metaCampaign','metaAd','sourceRecordLink','creative','creativeAlias','creativePlacement','adsetProductHistory','adsetStageHistory','productMatchRule'] as const;
export const META_PRELOAD_HISTORY_MODEL='metaAdsetPointerCandidate';
export const META_PRELOAD_POINTER_FIELDS=['id','metaAdsetId','metricDate','source','connectionId','productId','stage','isCurrent'] as const;
export const META_PRELOAD_MAX_BYTES=16*1024*1024;
const LIMIT=50001;
const models=new Map(Prisma.dmmf.datamodel.models.map(m=>[m.name[0].toLowerCase()+m.name.slice(1),m]));
const ident=(name:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))syncError('RECONCILIATION_FAILED');return '"'+name+'"';};
function table(model:string){const m=models.get(model);if(!m)syncError('RECONCILIATION_FAILED');return ident(m.dbName??m.name);}
function jsonRow(model:string,only?:readonly string[]){const fields=models.get(model)!.fields.filter(f=>f.kind!=='object'&&(!only||only.includes(f.name)));const groups:string[]=[];
 for(let start=0;start<fields.length;start+=25)groups.push(`jsonb_build_object(${fields.slice(start,start+25).flatMap(f=>{const column='t.'+ident(f.dbName??f.name);return ["'"+f.name+"'",f.type==='DateTime'?`CASE WHEN pg_typeof(${column})='timestamp with time zone'::regtype THEN to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE to_char(${column},'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`:['Decimal','BigInt'].includes(f.type)?`${column}::text`:column];}).join(',')})`);
 return '('+groups.join(' || ')+')';}

function hydrate(model:string,row:any,only?:readonly string[]){if(!row||typeof row!=='object'||Array.isArray(row))syncError('RECONCILIATION_FAILED');const fields=models.get(model)!.fields.filter(f=>f.kind!=='object'&&(!only||only.includes(f.name)));if(Object.keys(row).length!==fields.length||fields.some(f=>!Object.hasOwn(row,f.name)))syncError('RECONCILIATION_FAILED');
 const one=(f:any,v:any):any=>{if(v===null){if(f.isRequired)syncError('RECONCILIATION_FAILED');return null;}if(f.isList){if(!Array.isArray(v))syncError('RECONCILIATION_FAILED');return v.map(x=>one({...f,isList:false},x));}
 if(f.type==='DateTime'){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)syncError('RECONCILIATION_FAILED');return new Date(v);}
 if(f.type==='Decimal'){if(typeof v!=='string'||!/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(v))syncError('RECONCILIATION_FAILED');const d=new Prisma.Decimal(v);if(!d.isFinite())syncError('RECONCILIATION_FAILED');return d;}
 if(f.type==='BigInt'){if(typeof v!=='string'||!/^[-]?\d+$/.test(v))syncError('RECONCILIATION_FAILED');return BigInt(v);}
 if(f.type==='Int'){if(!Number.isSafeInteger(v))syncError('RECONCILIATION_FAILED');return v;}
 if(f.type==='Float'){if(typeof v!=='number'||!Number.isFinite(v))syncError('RECONCILIATION_FAILED');return v;}
 if(f.type==='Boolean'){if(typeof v!=='boolean')syncError('RECONCILIATION_FAILED');return v;}
 if(f.kind==='enum'||f.type==='String'){if(typeof v!=='string')syncError('RECONCILIATION_FAILED');return v;}
 if(f.type==='Json')return v;
 syncError('RECONCILIATION_FAILED');};
 return Object.fromEntries(fields.map(f=>[f.name,one(f,row[f.name])]));
}
export function decodeMetaDayPreload(rows:unknown){const r=(rows as any)?.[0];if(!Array.isArray(rows)||rows.length!==1||!r||r.oversized!==false||typeof r.payload!=='string'||Buffer.byteLength(r.payload)>META_PRELOAD_MAX_BYTES)syncError('RUN_LIMIT_EXCEEDED');let data:any;try{data=JSON.parse(r.payload);}catch{syncError('RECONCILIATION_FAILED');}if(!data||Array.isArray(data)||Object.keys(data).length!==META_PRELOAD_MODELS.length+1)syncError('RECONCILIATION_FAILED');const result=new Map<string,any[]>();for(const model of META_PRELOAD_MODELS){if(!Array.isArray(data[model]))syncError('RECONCILIATION_FAILED');if(data[model].length>50000)syncError('RUN_LIMIT_EXCEEDED');result.set(model,data[model].map((row:any)=>hydrate(model,row)));}const history=data[META_PRELOAD_HISTORY_MODEL];if(!Array.isArray(history))syncError('RECONCILIATION_FAILED');if(history.length+(result.get('metaAdsetDailyMetric')?.length??0)>50000)syncError('RUN_LIMIT_EXCEEDED');result.set(META_PRELOAD_HISTORY_MODEL,history.map((row:any)=>hydrate('metaAdsetDailyMetric',row,META_PRELOAD_POINTER_FIELDS)));return result;}
export async function preloadMetaDay(tx:Prisma.TransactionClient,scope:{connectionId:string;metricDate:Date;ads:MetaApiAd[];adsets:MetaApiAdset[]}){
 const day=scope.metricDate.toISOString().slice(0,10),keyHash=(...p:string[])=>createHash('sha256').update(JSON.stringify(p.map(v=>v.trim()))).digest('hex');
 const arg={connectionId:scope.connectionId,day,adsets:[...new Set(scope.adsets.map(r=>r.adsetId))],campaigns:[...new Set(scope.adsets.map(r=>r.campaignId))],ads:[...new Set(scope.ads.map(r=>r.adId))],creativeKeys:[...new Set(scope.ads.map(r=>r.creative.creativeKey))],hashes:[...scope.ads.map(r=>keyHash(scope.connectionId,day,r.campaignId,r.adsetId,r.adId)),...scope.adsets.map(r=>keyHash(scope.connectionId,day,r.adsetId))]};
 const filters:Record<string,string>={
 metaAdDailyMetric:`t.connection_id=s.id AND t.metric_date=s.metric_day`,
 metaAdset:`t.connection_id=s.id AND (t.external_adset_id IN(SELECT jsonb_array_elements_text(s.body->'adsets') UNION SELECT meta_adset_id FROM day_ads) OR t.id IN(SELECT meta_adset_ref_id FROM day_ads UNION SELECT meta_adset_id FROM day_adsets))`,
 metaCampaign:`t.connection_id=s.id AND (t.meta_campaign_id IN(SELECT jsonb_array_elements_text(s.body->'campaigns')) OR t.id IN(SELECT campaign_ref_id FROM selected_adsets))`,
 metaAd:`t.connection_id=s.id AND (t.ad_identity_key IN(SELECT jsonb_array_elements_text(s.body->'ads')) OR t.id IN(SELECT meta_ad_ref_id FROM day_ads))`,
 sourceRecordLink:`t.connection_id=s.id AND (t.canonical_key_hash IN(SELECT jsonb_array_elements_text(s.body->'hashes')) OR t.record_id IN(SELECT id FROM day_ads UNION SELECT id FROM day_adsets))`,
 creative:`t.platform='META' AND (t.creative_key IN(SELECT jsonb_array_elements_text(s.body->'creativeKeys')) OR t.id IN(SELECT creative_id FROM selected_ads))`,
 creativeAlias:`t.creative_id IN(SELECT id FROM selected_creatives)`,creativePlacement:`t.connection_id=s.id AND t.creative_id IN(SELECT id FROM selected_creatives)`,
 adsetProductHistory:`t.meta_adset_id IN(SELECT id FROM selected_adsets)`,adsetStageHistory:`t.meta_adset_id IN(SELECT id FROM selected_adsets)`,
 productMatchRule:`t.is_active AND EXISTS(SELECT 1 FROM ${table('product')} p WHERE p.id=t.product_id AND p.is_active)`};
 const cte=(name:string,model:string,filter:string,only?:readonly string[])=>{const columns=only?models.get(model)!.fields.filter(f=>only.includes(f.name)).map(f=>'t.'+ident(f.dbName??f.name)).join(','):'t.*';return `${name} AS MATERIALIZED (SELECT ${columns} FROM ${table(model)} t CROSS JOIN scope s WHERE ${filter} LIMIT ${LIMIT})`;};
 const ctes=[`scope AS (SELECT (body->>'connectionId')::uuid id,(body->>'day')::date AS metric_day,body FROM (SELECT $1::jsonb body) a)`,cte('day_ads','metaAdDailyMetric',filters.metaAdDailyMetric),cte('day_adsets','metaAdsetDailyMetric','t.connection_id=s.id AND t.metric_date=s.metric_day'),cte('selected_adsets','metaAdset',filters.metaAdset),cte('historical_adsets','metaAdsetDailyMetric','t.connection_id=s.id AND t.is_current AND t.metric_date<>s.metric_day AND t.meta_adset_id IN(SELECT id FROM selected_adsets)',META_PRELOAD_POINTER_FIELDS),cte('selected_ads','metaAd',filters.metaAd),cte('selected_creatives','creative',filters.creative)];
 const sources:Record<string,string>={metaAdDailyMetric:'day_ads',metaAdsetDailyMetric:'day_adsets',metaAdset:'selected_adsets',metaAd:'selected_ads',creative:'selected_creatives'};
 for(const model of META_PRELOAD_MODELS)if(!sources[model]){sources[model]='pre_'+model;ctes.push(cte(sources[model],model,filters[model]));}
 const pairs=[...META_PRELOAD_MODELS.map(model=>`'${model}',(SELECT coalesce(jsonb_agg(${jsonRow(model)}),'[]'::jsonb) FROM ${sources[model]} t)`),`'${META_PRELOAD_HISTORY_MODEL}',(SELECT coalesce(jsonb_agg(${jsonRow('metaAdsetDailyMetric',META_PRELOAD_POINTER_FIELDS)}),'[]'::jsonb) FROM historical_adsets t)`];
 const sql=`WITH ${ctes.join(',')}, envelope AS(SELECT jsonb_build_object(${pairs.join(',')})::text payload) SELECT octet_length(payload)>${META_PRELOAD_MAX_BYTES} AS oversized,CASE WHEN octet_length(payload)<=${META_PRELOAD_MAX_BYTES} THEN payload ELSE NULL END AS payload FROM envelope`;
 const serialized=JSON.stringify(arg);if(Buffer.byteLength(serialized)>META_PRELOAD_MAX_BYTES)syncError('RUN_LIMIT_EXCEEDED');
 return decodeMetaDayPreload(await tx.$queryRawUnsafe(sql,serialized));
}
