// Local 09-only repair. No proxy, remote URL, reset, drop or user-data copy.
import { PrismaClient } from '@prisma/client';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
const target='phase09_storefront_20261019';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation';
const output=`${root}/local09-migration-repair-20261019.json`;
let client:PrismaClient|undefined;let stage='LOCAL_TARGET';
const safe=(result:ReturnType<typeof spawnSync>)=>{
 const text=String(result.stdout??'')+'\n'+String(result.stderr??'');
 const codes=[...new Set(text.match(/\bP\d{4}\b/g)??[])];
 return {exitCode:result.status,codes,shadowSameDatabaseRejected:/shadow[\s\S]{0,180}(same|identical)[\s\S]{0,180}(main|database)/i.test(text),
  connectionRejected:/P1000|P1001|P1002/.test(text),rawOutputSuppressed:true};
};
try{
 if(existsSync(output))throw Error('NO_OVERWRITE');
 const receipt=JSON.parse(readFileSync(`${root}/proxy06-receipt-20261019-v2.json`,'utf8'));
 if(receipt.kind!=='PHASE09_CAFE_TEMPORARY_PROXY_RECEIPT'||receipt.restoredOriginalEmpty!==true||receipt.childFailureStage!=='EXISTING_MIGRATIONS_LOCAL_ONLY'||receipt.sourceDatabaseWrites!==0)throw Error('V2_RECEIPT');
 const inspect=JSON.parse(execFileSync('docker',['inspect','meta-ads-phase03-pg-0929'],{encoding:'utf8'}))[0];
 if(inspect.State.Status!=='running'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostIp!=='127.0.0.1'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort!=='55433')throw Error('LOCAL_CONTAINER');
 const env=inspect.Config.Env as string[],password=env.find(s=>s.startsWith('POSTGRES_PASSWORD='))?.slice(18),user=env.find(s=>s.startsWith('POSTGRES_USER='))?.slice(14)??'postgres';
 if(!password)throw Error('LOCAL_CREDENTIAL');
 const url=`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:55433/${target}?schema=meta_ads&connection_limit=1`;
 const shadow=`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:55433/phase09_shadow_unused_20261019?schema=meta_ads&connection_limit=1`;
 client=new PrismaClient({datasourceUrl:url});
 const before=await client.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  return tx.$queryRawUnsafe<Array<{database:string;tables:number}>>(`SELECT current_database() AS database,(SELECT count(*)::int FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') AND table_type='BASE TABLE') AS tables`);
 });
 if(before[0]?.database!==target||before[0]?.tables!==0)throw Error('NOT_EMPTY_09_DATABASE');
 const cli='node_modules/prisma/build/index.js',schema='apps/api/prisma/schema.prisma';
 stage='DIAGNOSE_SAME_SHADOW';
 const original=spawnSync(process.execPath,[cli,'validate','--schema',schema],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:url},encoding:'utf8',timeout:30_000,maxBuffer:1_048_576,windowsHide:true});
 const originalSafe=safe(original);
 // A dedicated unused local name is config only: migrate deploy uses no shadow
 // database. Prove the name remains absent before and after the operation.
 const beforeShadow=await client.$queryRawUnsafe<Array<{exists:boolean}>>('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists','phase09_shadow_unused_20261019');
 if(beforeShadow[0]?.exists)throw Error('SHADOW_NAME_ALREADY_EXISTS');
 stage='VALIDATE_DISTINCT_UNUSED_SHADOW';
 const validation=spawnSync(process.execPath,[cli,'validate','--schema',schema],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:shadow},encoding:'utf8',timeout:30_000,maxBuffer:1_048_576,windowsHide:true});
 const validationSafe=safe(validation);
 if(validation.status!==0||validation.error)throw Error('DISTINCT_SHADOW_VALIDATION_FAILED');
 const migrations=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(r=>r.isDirectory()).map(r=>r.name).sort();
 if(migrations.length!==51||migrations.at(-1)!=='20261012170000_scheduled_unit_checkpoints')throw Error('MIGRATION_SCOPE');
 const hashes=migrations.map(name=>[name,createHash('sha256').update(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`)).digest('hex')]);
 stage='DEPLOY_EXISTING_51_ONLY_TO_09';
 const deploy=spawnSync(process.execPath,[cli,'migrate','deploy','--schema',schema],{env:{...process.env,DATABASE_URL:url,SHADOW_DATABASE_URL:shadow},encoding:'utf8',timeout:90_000,maxBuffer:1_048_576,windowsHide:true});
 const deploySafe=safe(deploy);
 if(deploy.status!==0||deploy.error){console.log(JSON.stringify({kind:'PHASE09_LOCAL_MIGRATION_DEPLOY_REJECTED',stage,diagnosis:deploySafe}));throw Error('DEPLOY_FAILED');}
 stage='READONLY_FINAL';
 const after=await client.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  return tx.$queryRawUnsafe<Array<{database:string;migrations:number;users:number;credentials:number;connections:number;lines:number;products:number;shadowExists:boolean}>>(`SELECT current_database() AS database,(SELECT count(*)::int FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations,(SELECT count(*)::int FROM meta_ads.app_users) AS users,(SELECT count(*)::int FROM meta_ads.source_credentials) AS credentials,(SELECT count(*)::int FROM meta_ads.source_connections) AS connections,(SELECT count(*)::int FROM meta_ads.cafe24_order_lines) AS lines,(SELECT count(*)::int FROM meta_ads.products) AS products,EXISTS(SELECT 1 FROM pg_database WHERE datname='phase09_shadow_unused_20261019') AS "shadowExists"`);
 });
 const verified=after[0]?.database===target&&after[0]?.migrations===51&&after[0]?.users===0&&after[0]?.credentials===0&&after[0]?.connections===0&&after[0]?.lines===0&&after[0]?.products===0&&after[0]?.shadowExists===false;
 if(!verified)throw Error('FINAL_GUARD');
 const evidence={kind:'PHASE09_LOCAL_EMPTY_SCHEMA_REPAIR_VERIFIED',verified:true,observedAt:new Date().toISOString(),targetDatabase:target,before:before[0],diagnosis:{originalSameShadow:originalSafe,distinctUnusedShadow:validationSafe,deploy:deploySafe},after:after[0],migrationFilesSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),existingMigrationsApplied:51,newPhase09Migrations:0,remoteWrites:0,sourceDatabaseWrites:0,proxyCalls:0,providerCalls:0,shadowDatabaseCreated:false};
 writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({kind:evidence.kind,verified:true,diagnosis:evidence.diagnosis,after:evidence.after,evidence:output}));
}catch(error:any){console.log(JSON.stringify({kind:'PHASE09_LOCAL_MIGRATION_REPAIR_FAILED',stage,code:/^P\d{4}$/.test(error?.code)?error.code:'SAFE_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}
finally{await client?.$disconnect();}
