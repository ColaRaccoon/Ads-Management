import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

test("실제 Prisma 환율 take2가 추가하는 id 정렬을 재현하고 id SELECT만으로 복구한다",async()=>{
 const urls=Object.fromEntries(["owner","worker","report"].map(role=>{
  const value=process.env[`UNIFIED_STAGE11_FK_${role.toUpperCase()}_URL`];assert(value);const url=new URL(value);
  assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55461");assert.equal(url.pathname,"/unified_stage11_roles");
  assert.equal(url.username,role==="owner"?"fixture_owner":`meta_ads_unified_${role}`);return[role,value];
 }));
 const owner=new PrismaClient({datasourceUrl:urls.owner}),worker=new PrismaClient({datasourceUrl:urls.worker,log:[{emit:"event",level:"query"}]}),report=new PrismaClient({datasourceUrl:urls.report});
 const queryMetadata:Array<{table:string;columns:string[];orderByColumns:string[];parametersRecorded:boolean}>=[];
 worker.$on("query",event=>{
  if(!event.query.includes('"exchange_rates"'))return;
  const columns=[...new Set([...event.query.matchAll(/"exchange_rates"\."([a-z_]+)"/g)].map(match=>match[1]))].sort();
  const orderBy=event.query.match(/ORDER BY ([\s\S]*?)(?: LIMIT | OFFSET |$)/)?.[1]??"";
  queryMetadata.push({table:"meta_ads.exchange_rates",columns,orderByColumns:[...new Set([...orderBy.matchAll(/"exchange_rates"\."([a-z_]+)"/g)].map(match=>match[1]))].sort(),parametersRecorded:false});
 });
 const evidence:Record<string,unknown>={stage:11,kind:"LOCAL_ACTUAL_PRISMA_FX_IMPLICIT_PRIMARY_KEY_REHEARSAL",remoteWrites:0,status:"RUNNING",queryMetadata};
 try{
  const [identity]=await owner.$queryRaw<Array<{database:string;role:string}>>`SELECT current_database() database,current_user role`;
  assert.equal(identity.database,"unified_stage11_roles");assert.equal(identity.role,"fixture_owner");
  await owner.$executeRawUnsafe('REVOKE SELECT(id) ON meta_ads.exchange_rates FROM meta_ads_unified_worker');
  const oldColumns='"base_currency","fallback_type","provider","quote_currency","rate","rate_date","source_date"';
  await worker.$queryRawUnsafe(`SELECT ${oldColumns} FROM meta_ads.exchange_rates LIMIT 0`);
  const read=(currency:string)=>worker.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
   return tx.exchangeRate.findMany({where:{rateDate:new Date("2026-10-28T00:00:00.000Z"),baseCurrency:currency,quoteCurrency:"KRW",provider:"KOREA_EXIM"},take:2,
    select:{rate:true,sourceDate:true,provider:true,fallbackType:true}});
  });
  const failures:Array<{currency:string;className:string;permissionDenied:boolean}>=[];
  for(const currency of ["USD","KRW"]){
   await assert.rejects(read(currency),error=>{
    assert(error instanceof Error);assert.match(error.message,/permission denied for table exchange_rates/);
    failures.push({currency,className:error.constructor.name,permissionDenied:true});return true;
   });
  }
  evidence.beforeIdGrant={declaredSevenColumnsSelectSucceeded:true,actualPrismaFailures:failures};
  assert(queryMetadata.some(meta=>meta.orderByColumns.includes("id")));
  // Local-only minimal ACL change; the harness separately executes the full corrective SQL as its owner.
  await owner.$executeRawUnsafe('GRANT SELECT(id) ON meta_ads.exchange_rates TO meta_ads_unified_worker');
  for(const currency of ["USD","KRW"])assert.equal((await read(currency)).length,0);
  evidence.afterIdGrant={sameActualPrismaUsdAndKrwReads:"PASS",addedColumn:"id"};
  const permissions=await worker.$queryRaw<Array<{id_select:boolean;broad_select:boolean;provider_payload:boolean;writable_columns:bigint}>>`SELECT has_column_privilege(current_user,'meta_ads.exchange_rates','id','SELECT') id_select,has_table_privilege(current_user,'meta_ads.exchange_rates','SELECT') broad_select,has_column_privilege(current_user,'meta_ads.exchange_rates','provider_payload','SELECT') provider_payload,(SELECT count(*) FROM pg_attribute a WHERE a.attrelid='meta_ads.exchange_rates'::regclass AND a.attnum>0 AND NOT a.attisdropped AND(has_column_privilege(current_user,a.attrelid,a.attnum,'INSERT') OR has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE'))) writable_columns`;
  assert.equal(permissions[0].id_select,true);assert.equal(permissions[0].broad_select,false);assert.equal(permissions[0].provider_payload,false);assert.equal(permissions[0].writable_columns,0n);
  await assert.rejects(worker.$queryRawUnsafe('SELECT provider_payload FROM meta_ads.exchange_rates LIMIT 0'));
  await assert.rejects(worker.$executeRawUnsafe('DELETE FROM meta_ads.exchange_rates WHERE false'));
  await assert.rejects(report.$queryRawUnsafe('SELECT id FROM meta_ads.exchange_rates LIMIT 0'));
  evidence.permissions={idSelect:true,broadSelect:false,providerPayloadSelect:false,sourceWritableColumns:0,reportSourceSelect:false};
  evidence.status="PASS";
 }finally{
  await Promise.all([owner.$disconnect(),worker.$disconnect(),report.$disconnect()]);
  writeFileSync("docs/product-performance/research/11-data-fx-projection-fixture.json",JSON.stringify(evidence,null,2)+"\n");
 }
});
