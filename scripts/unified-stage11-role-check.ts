import 'reflect-metadata';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { readFileSync,writeFileSync } from 'node:fs';
import { UnifiedRuntimePrisma } from '../apps/api/src/unified-performance/runtime-prisma';

async function main(){
 process.env.UNIFIED_PERFORMANCE_ENABLED='true';
 const report=new UnifiedRuntimePrisma(), worker=new PrismaClient({datasourceUrl:process.env.UNIFIED_AGGREGATION_DATABASE_URL});
 const result:Record<string,unknown>={stage:11,observedAt:new Date().toISOString(),kind:'ACTUAL_RESTRICTED_LOGIN_CHECK',sourceWrites:0,checks:[]};
 const checks=result.checks as string[];
 const denied=async(client:PrismaClient,sql:string,label:string)=>{
  await assert.rejects(client.$queryRawUnsafe(sql),(error:any)=>error.code==='P2010'&&error.meta?.code==='42501',label);
  checks.push(label);
 };
 try{
  await report.onModuleInit();checks.push('feature-only report client passes actual role startup checks');
  for(const [name,client] of [['report',report],['worker',worker]] as const){
   const [role]=await client.$queryRawUnsafe<any[]>(`SELECT current_user role,current_database() db,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,
    (SELECT count(*)::text FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`);
   assert.equal(role.role,`meta_ads_unified_${name}`);assert.equal(role.db,'postgres');assert.equal(role.owns,'0');
   for(const key of ['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','rolinherit'])assert.equal(role[key],false);
   result[`${name}Identity`]=role;
   for(const column of ['credential_ref','external_account_id'])await denied(client,`SELECT ${column} FROM meta_ads.source_connections LIMIT 0`,`${name} denies source connection ${column}`);
   for(const table of ['app_auth_sessions','local_credentials'])await denied(client,`SELECT * FROM meta_ads.${table} LIMIT 0`,`${name} denies ${table}`);
  }
  await report.$queryRawUnsafe('SELECT id,provider,display_name,currency_code,time_zone FROM meta_ads.source_connections LIMIT 1');
  for(const table of ['unified_products','unified_rules','unified_mapping_audits','unified_aggregation_runs','unified_source_publications','unified_daily_facts','unified_source_coverage'])
   await report.$queryRawUnsafe(`SELECT * FROM meta_ads.${table} LIMIT 0`);
  await denied(report,'SELECT * FROM meta_ads.cafe24_order_lines LIMIT 0','report denies raw Cafe24 source');
  await denied(report,'SELECT * FROM public.order_items LIMIT 0','report denies raw Naver source');
  await denied(report,'SELECT * FROM meta_ads.unified_product_match_results LIMIT 0','report denies internal match audit');
  const proposal=JSON.parse(readFileSync('docs/product-performance/research/11-data-source-access-proposal.json','utf8'));
  const sourceAccess=[];
  for(const table of [...proposal.metaAds,...proposal.naver]){
   result.currentCheck=`${table.schema}.${table.table}`;result.sourceAccess=sourceAccess;
   const cols=table.columns.map((column:string)=>`"${column}"`).join(',');
   await worker.$queryRawUnsafe(`SELECT ${cols} FROM "${table.schema}"."${table.table}" LIMIT 0`);
   const [privileges]=await worker.$queryRawUnsafe<any[]>(`SELECT has_any_column_privilege(current_user,'${table.schema}.${table.table}','INSERT') i,
    has_any_column_privilege(current_user,'${table.schema}.${table.table}','UPDATE') u,has_table_privilege(current_user,'${table.schema}.${table.table}','DELETE') d,
    has_table_privilege(current_user,'${table.schema}.${table.table}','TRUNCATE') t`);
   if(!table.table.startsWith('unified_'))assert(Object.values(privileges).every(value=>value===false));
   sourceAccess.push({schema:table.schema,table:table.table,select:true,...privileges});
  }
  result.sourceAccess=sourceAccess;checks.push('worker exact 44-table column SELECT succeeds; all source DML/TRUNCATE privileges false');
  result.status='PASS';
 }catch(error){result.status='FAIL';result.errorCode=(error as any).code??'ROLE_CHECK_FAILED';result.databaseCode=(error as any).meta?.code??null;result.errorLabel=(error as any).code?'DATABASE_OR_ASSERTION_ERROR':(error as Error).message;process.exitCode=1;}
 finally{await Promise.all([report.onModuleDestroy(),worker.$disconnect()]);writeFileSync('docs/product-performance/research/11-runtime-role-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,checks:checks.length,sourceWrites:0}));}
}
main().catch(()=>{console.error('STAGE11_ROLE_CHECK_FAILED');process.exitCode=1;});
