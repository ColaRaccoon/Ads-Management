// Production metadata only: a dedicated read-only transaction, no row payloads.
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
let raw='',input,db,stage='INPUT';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
try{
 for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error('BOUND')}
 input=JSON.parse(raw);raw='';const u=new URL(input.databaseUrl);
 const direct=u.hostname==='db.iygjmosbelbosfxidqxv.supabase.co'&&u.username==='meta_ads_prod_runtime';
 const pool=u.hostname.endsWith('.pooler.supabase.com')&&u.username==='meta_ads_prod_runtime.iygjmosbelbosfxidqxv';
 if(input.projectRef!=='iygjmosbelbosfxidqxv'||!(direct||pool)||u.pathname!=='/postgres'||u.searchParams.get('schema')!=='meta_ads'||u.searchParams.get('sslmode')!=='verify-full')throw Error('TARGET');
 db=new PrismaClient({datasourceUrl:input.databaseUrl});stage='READ_ONLY_METADATA';
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='15000'");
  const [identity]=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly");
  if(identity.database!=='postgres'||identity.role!=='meta_ads_prod_runtime'||identity.schema!=='meta_ads'||identity.readonly!=='on')throw Error('IDENTITY');
  const tables=await tx.$queryRawUnsafe("SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' ORDER BY c.relname");
  const columns=await tx.$queryRawUnsafe("SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum");
  const indexes=await tx.$queryRawUnsafe("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='meta_ads' ORDER BY tablename,indexname");
  return {identity,tables,columns,indexes};
 },{maxWait:2000,timeout:20000,isolationLevel:'RepeatableRead'});
 console.log(JSON.stringify({kind:'PHASE10_OPERATING_SCHEMA_READ_ONLY',observedAt:new Date().toISOString(),identity:result.identity,tableCount:result.tables.length,columnCount:result.columns.length,indexCount:result.indexes.length,schemaMetadataSha256:hash(result),tables:result.tables.map(t=>t.name),metadata:result,productionBusinessRowsRead:0,productionWrites:0,providerRequests:0}));
}catch{console.log(JSON.stringify({kind:'PHASE10_OPERATING_SCHEMA_READ_REJECTED',stage,productionWrites:0,rawErrorSuppressed:true}));process.exitCode=1}
finally{input=undefined;raw='';await db?.$disconnect().catch(()=>{})}
