// Review-only preparation. The parent opens one temporary, pinned nonproduction
// proxy; this child receives its URL on stdin and never emits raw source rows.
import { Prisma, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { databaseUrlWithConnectionLimit } from '../../../apps/api/src/common/prisma.service';
import type { PrismaService } from '../../../apps/api/src/common/prisma.service';
import { StorefrontReadService } from '../../../apps/api/src/storefront/storefront-read.service';

const DIRECTORY='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation';
const TARGET='phase09_storefront_20261019';
const DESTINATION=`${DIRECTORY}/actual06-summary.json`;
const DATE=new Date('2026-10-01T00:00:00.000Z');
const jsonNull=(value:Prisma.JsonValue|null)=>value===null?Prisma.DbNull:value;
let source:PrismaClient|undefined,target:PrismaClient|undefined;
let stage='INPUT';
function fail(value:string):never{throw new Error(value);}
function stable(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(Prisma.Decimal.isDecimal(value))return JSON.stringify(value.toString());
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
}
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
const semantic=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['createdAt','updatedAt','note'].includes(key)));

try {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>8192)fail('INPUT_BOUND');}
  const input=JSON.parse(raw);raw='';
  if(Object.keys(input).sort().join(',')!=='projectId,proxyId,serviceId,url'||
    input.projectId!=='d72f4256-8632-437a-9dae-9b5d96736fc7'||input.serviceId!=='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'||
    typeof input.proxyId!=='string'||!/^[A-Za-z0-9-]{8,128}$/.test(input.proxyId))fail('INPUT_IDENTITY');
  const remoteUrl=new URL(input.url);input.url='';
  if(!remoteUrl.hostname.endsWith('.proxy.rlwy.net')||remoteUrl.pathname!=='/railway'||!remoteUrl.port)fail('REMOTE_URL');
  remoteUrl.searchParams.set('schema','public');
  if(existsSync(DESTINATION))fail('EVIDENCE_ALREADY_EXISTS');
  const repair=JSON.parse(readFileSync(`${DIRECTORY}/local09-migration-repair-20261019.json`,'utf8'));
  if(repair.kind!=='PHASE09_LOCAL_EMPTY_SCHEMA_REPAIR_VERIFIED'||repair.verified!==true||repair.targetDatabase!==TARGET||
    repair.after?.migrations!==51||repair.after?.users!==0||repair.after?.credentials!==0||repair.after?.connections!==0||repair.after?.lines!==0||repair.after?.products!==0||repair.shadowDatabaseCreated!==false)fail('PREPARED_SCHEMA_RECEIPT');
  stage='REMOTE_READONLY';
  source=new PrismaClient({datasourceUrl:databaseUrlWithConnectionLimit(remoteUrl.toString(),'1')});
  const snapshot=await source.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const identity=await tx.$queryRawUnsafe<Array<{database:string;schema:string;readOnly:string;tables:number}>>(`SELECT current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS "readOnly",(SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables`);
    if(identity.length!==1||identity[0].database!=='railway'||identity[0].schema!=='public'||identity[0].readOnly!=='on'||identity[0].tables!==22)fail('REMOTE_DATABASE_IDENTITY');
    const connections=await tx.sourceConnection.findMany({where:{provider:'CAFE24',externalAccountId:'didadi0729',shopKey:'shop1'},take:2});
    const c=connections[0];if(connections.length!==1||c.currencyCode!=='KRW'||c.timeZone!=='Asia/Seoul')fail('REMOTE_ACCOUNT_IDENTITY');
    const policies=await tx.sourcePolicy.findMany({where:{connectionId:c.id,dataKind:'CAFE24_ORDER',fromDate:{lte:DATE},OR:[{toDate:null},{toDate:{gt:DATE}}]},take:3});
    if(policies.length!==1||policies[0].primarySource!=='API')fail('REMOTE_SELECTED_SOURCE');
    const lines=await tx.cafe24OrderLine.findMany({where:{connectionId:c.id,source:'API',isCurrent:true,orderDate:DATE},take:478});
    if(lines.length!==477||lines.some(r=>r.uploadBatchId!==null||r.supersededByOrderLineId!==null))fail('REMOTE_LINES_BOUND');
    const versions=await tx.cafe24OrderApiVersion.findMany({where:{connectionId:c.id,isCurrent:true,orderDate:DATE},take:478});
    const links=await tx.sourceRecordLink.findMany({where:{connectionId:c.id,dataKind:'CAFE24_ORDER',source:'API',recordTable:'cafe24_order_lines',recordId:{in:lines.map(r=>r.id)},isCurrent:true},take:478});
    const coverage=await tx.sourceCoverage.findMany({where:{connectionId:c.id,dataKind:'CAFE24_ORDER',metricDate:DATE},take:2});
    if(versions.length!==477||links.length!==477||coverage.length!==1||coverage[0].rowCount!==477||!coverage[0].lastSuccessRunId||!coverage[0].lastSuccessAt)fail('REMOTE_LINEAGE_BOUND');
    const runIds=[...new Set([...versions.map(r=>r.syncRunId),...links.flatMap(r=>r.syncRunId?[r.syncRunId]:[]),...coverage.flatMap(r=>[r.lastSuccessRunId,r.lastAttemptRunId].filter((v):v is string=>!!v))])];
    const runs=await tx.syncRun.findMany({where:{connectionId:c.id,id:{in:runIds}},take:101});
    const units=await tx.runUnit.findMany({where:{runId:{in:runIds}},take:101});
    if(runs.length!==runIds.length||runs.length>100||units.length>100||units.some(r=>r.checkpointValue!==null))fail('REMOTE_RUN_BOUND');
    const ruleIds=[...new Set(lines.flatMap(r=>r.cafe24ProductRuleId?[r.cafe24ProductRuleId]:[]))];
    const rules=await tx.cafe24ProductRule.findMany({where:{id:{in:ruleIds}},take:101});
    if(rules.length!==ruleIds.length)fail('REMOTE_RULE_BOUND');
    const productIds=[...new Set([...lines.flatMap(r=>r.productId?[r.productId]:[]),...rules.map(r=>r.productId),...rules.flatMap(r=>r.adCostSourceProductId?[r.adCostSourceProductId]:[])])];
    const products=await tx.product.findMany({where:{id:{in:productIds}},take:101});
    const costs=await tx.productCostRule.findMany({where:{productId:{in:productIds},effectiveFrom:{lte:DATE},OR:[{effectiveTo:null},{effectiveTo:{gte:DATE}}]},take:101});
    if(products.length!==productIds.length||products.length>100||rules.length>100||costs.length>100)fail('REMOTE_CONFIGURATION_BOUND');
    return {identity:identity[0],connection:c,policies,lines,versions,links,coverage,runs,units,products,rules,costs};
  },{isolationLevel:'RepeatableRead',timeout:30_000});
  await source.$disconnect();source=undefined;
  stage='LOCAL_DOCKER_IDENTITY';
  const inspect=JSON.parse(execFileSync('docker',['inspect','meta-ads-phase03-pg-0929'],{encoding:'utf8'}))[0];
  if(inspect.State.Status!=='running'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostIp!=='127.0.0.1'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort!=='55433')fail('LOCAL_CONTAINER_IDENTITY');
  const env=inspect.Config.Env as string[];
  const password=env.find(s=>s.startsWith('POSTGRES_PASSWORD='))?.slice(18);
  const user=env.find(s=>s.startsWith('POSTGRES_USER='))?.slice(14)??'postgres';
  if(!password)fail('LOCAL_CREDENTIAL_MISSING');
  const localUrl=(db:string)=>`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:55433/${db}?schema=meta_ads&connection_limit=1`;
  // Reuse only the empty 09 database prepared and attested by this task. No
  // template clone, migration retry, database creation or reset happens here.
  target=new PrismaClient({datasourceUrl:localUrl(TARGET)});
  stage='PREPARED_LOCAL_SCHEMA';
  const migrations=readdirSync('apps/api/prisma/migrations',{withFileTypes:true}).filter(row=>row.isDirectory()).map(row=>row.name).sort();
  if(migrations.length!==51||migrations.at(-1)!=='20261012170000_scheduled_unit_checkpoints')fail('EXISTING_MIGRATIONS_CHANGED');
  const migrationFilesSha256=digest(migrations.map(name=>[name,createHash('sha256').update(readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`)).digest('hex')]));
  if(migrationFilesSha256!==repair.migrationFilesSha256)fail('PREPARED_SCHEMA_FILES_CHANGED');
  await target.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const applied=await tx.$queryRawUnsafe<Array<{database:string;schema:string;count:number}>>('SELECT current_database() AS database,current_schema() AS schema,(SELECT count(*)::int FROM meta_ads._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count');
    if(applied[0]?.database!==TARGET||applied[0]?.schema!=='meta_ads'||applied[0]?.count!==51||await tx.appUser.count()!==0||await tx.sourceCredential.count()!==0||await tx.sourceConnection.count()!==0||await tx.cafe24OrderLine.count()!==0||await tx.product.count()!==0)fail('PREPARED_SCHEMA_NOT_EMPTY');
  });
  stage='WRITE_ONLY_NEW_LOCAL_CLONE';
  const summary=await target.$transaction(async tx=>{
    const identity=await tx.$queryRawUnsafe<Array<{database:string;schema:string}>>('SELECT current_database() AS database,current_schema() AS schema');
    if(identity[0]?.database!==TARGET||identity[0]?.schema!=='meta_ads')fail('LOCAL_WRITE_TARGET_REJECTED');
    if(await tx.appUser.count()!==0||await tx.sourceCredential.count()!==0||await tx.cafe24OrderLine.count()!==0||await tx.sourceConnection.count()!==0||await tx.product.count()!==0)fail('LOCAL_CLONE_BASELINE_REJECTED');
    // Merge existing business configuration only when all semantic inputs match;
    // no credentials, user rows, OAuth attempts, CSV batches or raw row copies.
    for(const [model,rows] of [['product',snapshot.products],['productCostRule',snapshot.costs],['cafe24ProductRule',snapshot.rules]] as const){
      for(const row of rows){
        const delegate=(tx as any)[model];
        const existing=await delegate.findUnique({where:{id:row.id}});
        if(existing){if(digest(semantic(existing))!==digest(semantic(row)))fail('LOCAL_CONFIGURATION_CONFLICT');}
        else await delegate.create({data:'note' in row?{...row,note:null}:row});
      }
    }
    await tx.sourceConnection.create({data:{...snapshot.connection,credentialRef:null,credentialExpiresAt:null,enabled:false,accessState:'PENDING'}});
    await tx.sourcePolicy.createMany({data:snapshot.policies.map(r=>({...r,changedByUserId:null}))});
    await tx.syncRun.createMany({data:snapshot.runs.map(r=>({...r,actorUserId:null,providerRequestId:null}))});
    await tx.runUnit.createMany({data:snapshot.units});
    await tx.cafe24OrderApiVersion.createMany({data:snapshot.versions.map(r=>({...r,providerPaymentCodes:jsonNull(r.providerPaymentCodes)}))});
    await tx.cafe24OrderLine.createMany({data:snapshot.lines.map(r=>({...r,rawRow:Prisma.DbNull,providerPaymentCodes:jsonNull(r.providerPaymentCodes),validationErrors:[]}))});
    await tx.sourceRecordLink.createMany({data:snapshot.links});
    await tx.sourceCoverage.createMany({data:snapshot.coverage});
    process.env.DAILY_SYNC_FEATURE_ENABLED='true';process.env.DAILY_SYNC_SCHEDULE_ENABLED='false';
    const service=new StorefrontReadService({$transaction:async(inner:any)=>inner(tx)} as PrismaService);
    const result=await service.summary('2026-10-01','2026-10-01');
    if(result.totals.revenueKrw!=='19187900'||!result.coverage.some(c=>c.provider==='CAFE24'&&c.complete&&c.rowCount===477))fail('LOCAL_ACTUAL06_SUMMARY_MISMATCH');
    return result;
  },{isolationLevel:'ReadCommitted',timeout:30_000});
  stage='LOCAL_READONLY_RECHECK';
  const checked=await target.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const service=new StorefrontReadService({$transaction:async(inner:any)=>inner(tx)} as PrismaService);
    return service.summary('2026-10-01','2026-10-01');
  },{isolationLevel:'RepeatableRead',timeout:30_000});
  if(digest(checked)!==digest(summary))fail('LOCAL_READONLY_RECHECK_MISMATCH');
  const codeFiles=['apps/api/src/storefront/storefront-read.service.ts','apps/api/src/storefront/storefront-control.service.ts',
    'apps/api/src/storefront/storefront.controller.ts','apps/api/src/storefront/storefront.dto.ts','apps/api/src/storefront/storefront.types.ts',
    'apps/api/src/storefront/storefront.module.ts','apps/api/src/common/source-read-policy.ts','apps/api/src/common/meta-source-read-coverage.ts'];
  const codeHashes=Object.fromEntries(codeFiles.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
  writeFileSync(DESTINATION,JSON.stringify({kind:'PHASE09_CAFE_ACTUAL_SNAPSHOT_SUMMARY',actual:true,verified:true,
    sourceCodeSha256:createHash('sha256').update(JSON.stringify(codeHashes)).digest('hex'),codeHashes,
    observedAt:new Date().toISOString(),sourceProjectId:input.projectId,sourceServiceId:input.serviceId,
    sourceReadOnly:true,transactionReadOnly:true,sourceDatabaseWrites:0,providerCalls:0,targetDatabase:TARGET,
    targetPreparation:'REUSED_09_ONLY_EMPTY_SCHEMA_FROM_REPAIR_RECEIPT',preparedExistingMigrationCount:51,migrationsAppliedThisInvocation:0,newPhase09Migrations:0,migrationFilesSha256,
    usersCopied:0,credentialsCopied:0,oauthCopied:0,rawRowsCopied:0,sourceSnapshotSha256:digest(snapshot),
    counts:{products:snapshot.products.length,costRules:snapshot.costs.length,matchRules:snapshot.rules.length,
      apiLines:snapshot.lines.length,apiVersions:snapshot.versions.length,currentLinks:snapshot.links.length},
    summary:checked},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({kind:'PHASE09_CAFE_ACTUAL_SNAPSHOT_VERIFIED',verified:true,revenueKrw:'19187900',apiLines:477,sourceDatabaseWrites:0,providerCalls:0,targetDatabase:TARGET,evidence:DESTINATION}));
}catch(error:any){console.log(JSON.stringify({kind:'PHASE09_CAFE_ACTUAL_SNAPSHOT_FAILED',stage,
  code:/^P\d{4}$/.test(error?.code)?error.code:'SAFE_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}
finally{await Promise.allSettled([source?.$disconnect(),target?.$disconnect()]);}
