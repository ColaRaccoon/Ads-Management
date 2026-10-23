/** Bounded API-Meta transaction buffer. Domain decisions still run through the original writers.
 * No I/O survives the caller's transaction, and no CSV entry point uses this adapter. */
import {Prisma} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import type {MetaApiAd,MetaApiAdset} from './canonical-api-writer.service';
import {syncError} from './sync-contract';
import {preloadMetaDay,META_PRELOAD_HISTORY_MODEL} from './meta-day-preload';
type Row=Record<string,any>;
const WRITE_MODELS=['creative','metaCampaign','metaAdset','metaAd','creativeAlias','creativePlacement','metaAdDailyMetric','metaAdsetDailyMetric','sourceRecordLink'] as const;
const READ_MODELS=['adsetProductHistory','adsetStageHistory','productMatchRule'] as const;
const MAX_ROWS=50000,CHUNK=250;
const descriptors=new Map(Prisma.dmmf.datamodel.models.map(model=>[model.name[0].toLowerCase()+model.name.slice(1),model]));
const scalar=(v:any)=>v instanceof Date?v.getTime():v;
function matches(row:Row,where:Row={},model=''):boolean {
 return Object.entries(where).every(([key,test])=>{
  if(test===undefined)return true;
  if(key==='AND')return (Array.isArray(test)?test:[test]).every(x=>matches(row,x,model));
  if(key==='OR')return test.some((x:Row)=>matches(row,x,model));
  if(key==='NOT')return !(Array.isArray(test)?test:[test]).some(x=>matches(row,x,model));
  if(model==='productMatchRule'&&key==='product'){if(JSON.stringify(test)!==JSON.stringify({is:{isActive:true}}))syncError('RECONCILIATION_FAILED');return true;}
  if(test!==null&&typeof test==='object'&&!(test instanceof Date)&&!Array.isArray(test)){
   if(!Object.hasOwn(row,key)){if(!key.includes('_'))syncError('RECONCILIATION_FAILED');return matches(row,test,model);}
   return Object.entries(test).every(([operator,value])=>{
    const actual=scalar(row[key]),wanted=scalar(value);
    if(operator==='in')return (value as any[]).some(x=>scalar(x)===actual);
    if(operator==='notIn')return !(value as any[]).some(x=>scalar(x)===actual);
    if(operator==='equals')return actual===wanted;
    if(operator==='not')return !matches(row,{[key]:value},model);
    if(operator==='gte')return actual>=wanted;if(operator==='gt')return actual>wanted;
    if(operator==='lte')return actual<=wanted;if(operator==='lt')return actual<wanted;
    syncError('RECONCILIATION_FAILED');
   });
  }
  if(!Object.hasOwn(row,key))syncError('RECONCILIATION_FAILED');
  return scalar(row[key])===scalar(test);
 });
}
function select(row:Row,projection?:Row){if(!projection)return {...row};if(Object.entries(projection).some(([k,v])=>(v!==true&&v!==false)||(v===true&&!Object.hasOwn(row,k))))syncError('RECONCILIATION_FAILED');return Object.fromEntries(Object.entries(projection).filter(([,v])=>v).map(([k])=>[k,row[k]]));}
function normalizeData(data:Row){const out:Row={};for(const [key,value]of Object.entries(data)){if(value===undefined)continue;if(value!==null&&typeof value==='object'&&!(value instanceof Date)&&!Array.isArray(value)&&Object.keys(value).some(k=>['increment','decrement','set','connect','disconnect','create','upsert'].includes(k)))syncError('RECONCILIATION_FAILED');out[key]=value;}return out;}
function complete(model:string,data:Row):Row {
 const definition=descriptors.get(model);if(!definition)syncError('RECONCILIATION_FAILED');const out:Row={...data};
 for(const field of definition.fields){if(field.kind==='object'||out[field.name]!==undefined)continue;const def=field.default as any;
  if(field.name==='id')out.id=randomUUID();else if(field.isUpdatedAt||def?.name==='now')out[field.name]=new Date();else if(def!==undefined&&!(typeof def==='object'&&!Array.isArray(def)))out[field.name]=def;else if(!field.isRequired)out[field.name]=null;
 }
 return out;
}
export async function beginMetaDayBatch(tx:Prisma.TransactionClient,scope:{connectionId:string;metricDate:Date;ads:MetaApiAd[];adsets:MetaApiAdset[]}){
 const caches=await preloadMetaDay(tx,scope),created=new Map<string,Map<string,Row>>(),patches=new Map<string,Map<string,Row>>();
 const delegate=(model:string)=>{
  const rows=caches.get(model)!;
  const findMany=async(args:Row={})=>{
   if(Object.keys(args).some(k=>!['where','select','orderBy','take'].includes(k)))syncError('RECONCILIATION_FAILED');
   // Historical rows deliberately contain no metric metadata. Only the exact
   // pointer-selection read may observe them; every version/write path stays day-scoped.
   let readRows=rows;
   if(model==='metaAdsetDailyMetric'&&args.select&&Object.hasOwn(args.select,'source')){
    const expectedSelect={metaAdsetId:true,metricDate:true,source:true,connectionId:true,productId:true,stage:true};
    const keys=Object.keys(args.where??{}).sort();
    if(Object.keys(args).sort().join(',')!=='orderBy,select,where'||keys.join(',')!=='isCurrent,metaAdsetId'||args.where.isCurrent!==true||Object.keys(args.where.metaAdsetId??{}).join(',')!=='in'||!Array.isArray(args.where.metaAdsetId.in)||args.where.metaAdsetId.in.some((v:any)=>typeof v!=='string')||JSON.stringify(args.orderBy)!==JSON.stringify([{metricDate:'desc'},{id:'desc'}])||Object.keys(args.select).sort().join(',')!==Object.keys(expectedSelect).sort().join(',')||Object.values(args.select).some(v=>v!==true))syncError('RECONCILIATION_FAILED');
    readRows=[...rows,...caches.get(META_PRELOAD_HISTORY_MODEL)!];
   }
   let found=readRows.filter(row=>matches(row,args.where,model));const order=Array.isArray(args.orderBy)?args.orderBy:args.orderBy?[args.orderBy]:[];
   found=found.slice().sort((a,b)=>{for(const part of order)for(const [key,direction]of Object.entries(part)){if(direction!=='asc'&&direction!=='desc')syncError('RECONCILIATION_FAILED');const av=scalar(a[key]),bv=scalar(b[key]);if(av===bv)continue;if(av==null||bv==null)return (av==null?1:-1)*(direction==='asc'?1:-1);return (av<bv?-1:1)*(direction==='asc'?1:-1);}return 0;});
   if(args.take!==undefined){if(!Number.isInteger(args.take)||args.take<0||args.take>MAX_ROWS)syncError('RECONCILIATION_FAILED');found=found.slice(0,args.take);}return found.map(row=>{if(model==='metaAdsetDailyMetric'&&args.select?.metaAdset){if(JSON.stringify(args.select.metaAdset)!==JSON.stringify({select:{externalAdsetId:true}}))syncError('RECONCILIATION_FAILED');const parent=caches.get('metaAdset')!.find(item=>item.id===row.metaAdsetId);if(!parent)syncError('RECONCILIATION_FAILED');const projection={...args.select};delete projection.metaAdset;return {...select(row,projection),metaAdset:{externalAdsetId:parent.externalAdsetId}};}return select(row,args.select);});
  };
  const update=async(args:Row)=>{if(!(WRITE_MODELS as readonly string[]).includes(model))syncError('RECONCILIATION_FAILED');const found=rows.filter(row=>matches(row,args.where,model));if(found.length!==1)syncError('RECONCILIATION_FAILED');const row=found[0],data=normalizeData(args.data);const updated=descriptors.get(model)!.fields.find(f=>f.isUpdatedAt);if(updated)data[updated.name]=new Date();Object.assign(row,data);
   const fresh=created.get(model)?.get(row.id);if(fresh)Object.assign(fresh,data);else{const bucket=patches.get(model)??new Map();bucket.set(row.id,{...(bucket.get(row.id)??{}),...data});patches.set(model,bucket);}return select(row,args.select);};
  return {findMany,findFirst:async(args:Row={})=>(await findMany(args))[0]??null,findUnique:async(args:Row)=>(await findMany(args))[0]??null,
   count:async()=>syncError('RECONCILIATION_FAILED'),
   create:async(args:Row)=>{if(!(WRITE_MODELS as readonly string[]).includes(model))syncError('RECONCILIATION_FAILED');const data=normalizeData(args.data),row=complete(model,data);if(rows.some(x=>x.id===row.id))syncError('RECONCILIATION_FAILED');rows.push(row);const bucket=created.get(model)??new Map();bucket.set(row.id,{...data,id:row.id});created.set(model,bucket);return select(row,args.select);},update,
   updateMany:async(args:Row)=>{const found=rows.filter(row=>matches(row,args.where,model));for(const row of found)await update({where:{id:row.id},data:args.data});return {count:found.length};}};
 };
 const delegates=new Map<string,any>([...WRITE_MODELS,...READ_MODELS].map(model=>[model,delegate(model)]));
 const client=new Proxy(tx,{get(target,key){if(typeof key==='string'&&delegates.has(key))return delegates.get(key);const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;}}) as Prisma.TransactionClient;
 const batchUpdate=async(model:string,updates:Array<Row>)=>{
  const definition=descriptors.get(model)!;const table=definition.dbName??definition.name;
  const fields=new Map(definition.fields.filter(f=>f.kind!=='object').map(f=>[f.name,f.dbName??f.name]));
  const groups=new Map<string,Row[]>();for(const row of updates){const keys=Object.keys(row).filter(k=>k!=='id').sort();if(keys.some(k=>!fields.has(k)))syncError('RECONCILIATION_FAILED');const bucket=groups.get(keys.join(','))??[];bucket.push(row);groups.set(keys.join(','),bucket);}
  for(const [fieldKeys,group]of groups){if(!fieldKeys)continue;const keys=fieldKeys.split(',');for(let start=0;start<group.length;start+=CHUNK){
   const payload=group.slice(start,start+CHUNK).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[fields.get(k)!,v])));
   const json=JSON.stringify(payload,(_k,v)=>typeof v==='bigint'?v.toString():v);
   const assignments=Prisma.join(keys.map(k=>Prisma.raw(`"${fields.get(k)}"=r."${fields.get(k)}"`)));
   const count=await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw('"'+table+'"')} t SET ${assignments} FROM jsonb_populate_recordset(NULL::${Prisma.raw('"'+table+'"')},${json}::jsonb) r WHERE t.id=r.id`);
   if(count!==payload.length)syncError('RECONCILIATION_FAILED');
  }}
 };
 let flushed=false;
 return {client,flush:async()=>{
  if(flushed)syncError('RECONCILIATION_FAILED');flushed=true;
  // Current uniqueness must be released before inserting its replacement. New FK targets
  // are inserted in parent-first order; superseded pointers are updated afterwards.
  for(const model of ['metaAdDailyMetric','metaAdsetDailyMetric','sourceRecordLink']){
   const entries=[...(patches.get(model)?.entries()??[])].filter(([,data])=>data.isCurrent===false).map(([id,data])=>({id,isCurrent:false,...(data.updatedAt?{updatedAt:data.updatedAt}:{})}));if(entries.length)await batchUpdate(model,entries);
  }
  for(const model of WRITE_MODELS){const rows=[...(created.get(model)?.values()??[])];for(let start=0;start<rows.length;start+=CHUNK){const slice=rows.slice(start,start+CHUNK),out=await (tx as any)[model].createMany({data:slice});if(out.count!==slice.length)syncError('RECONCILIATION_FAILED');}}
  for(const model of WRITE_MODELS){const updates=[...(patches.get(model)?.entries()??[])].map(([id,data])=>({id,...data}));if(updates.length)await batchUpdate(model,updates);}
 }};
}
